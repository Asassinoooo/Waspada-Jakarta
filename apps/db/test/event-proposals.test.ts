import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import {
  createSqlEventProposalRepository,
  EventProposalConflictError,
  EventProposalReferenceError,
  EventProposalStorageError,
  EventProposalValidationError,
  type EventProposal,
  type ProposalClaim,
  type ProposalEvidenceReference,
} from '../src/event-proposals.js';
import { createRepositoryPorts } from '../src/ports.js';
import type { SqlExecutor, TransactionalSqlExecutor } from '../src/sql.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './harness.js';
import type { GroundingContextRecord } from '../src/grounding-contexts.js';

const WHEN = '2026-09-26T10:00:00Z';
const DATASET = 'synthetic' as const;
const TEXT = 'Authored synthetic fixture evidence describes a fictional road closure near the civic hall.';
const HASH = sha256(TEXT);
const ID = 'revision-proposal';
const BASE_TRACE = 'trace-proposal';
const REFRESH_TRACE = 'trace-proposal-refresh';
const OTHER_TRACE = 'trace-proposal-other';
const CANDIDATE = 'candidate-proposal';
const ORIGIN_A = 'origin-proposal-a';
const ORIGIN_B = 'origin-proposal-b';

describe('L2 grounded EventProposal persistence', () => {
  let db: TestDatabase;
  let ports: ReturnType<typeof createRepositoryPorts>;
  let refs: Record<'support' | 'support2' | 'contradiction' | 'updates' | 'context', ProposalEvidenceReference>;
  let context: GroundingContextRecord;
  let eventContext: GroundingContextRecord;

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(db.executor, migrations);
    ports = createRepositoryPorts(db.executor);
    refs = await seedFixture();
    context = await makeContext('context-proposal', BASE_TRACE);
    await ports.groundingContexts.createOrVerify(context);
    await seedEvent();
    eventContext = await makeContext('context-proposal-event', BASE_TRACE, [{ event_id: 'event-proposal', event_version: 1 }]);
    await ports.groundingContexts.createOrVerify(eventContext);
  });

  after(async () => db?.close());

  it('writes and fully replays canonical uncertain under-review drafts, all evidence relations and 4,000-code-point text', async () => {
    const before = await publicationCounts();
    const proposal = makeProposal({
      proposal_id: 'proposal-complete',
      claims: [makeClaim({
        text: 'x'.repeat(4000),
        event_time: { precision: 'date', start: '2026-09-26', end: '2026-09-28' },
        validity: { valid_from: '2026-09-26T10:00:00.123456+07:00', valid_until: null },
        support_assessment: 'uncertain',
        evidence_label: 'under_review',
        contradictions: [refs.contradiction],
        context_evidence: [refs.updates, refs.context],
        qualifiers: ['fictional', 'status_unverified'],
      })],
      unresolved_fields: ['service_status'],
      model_runs: [{ capability: 'reasoning', model_version: 'fixture-model-v1', prompt_version: 'fixture-prompt-v2', input_tokens: 100, output_tokens: 200 }],
    });
    const saved = await ports.eventProposals.createOrVerify(proposal);
    assert.deepEqual(saved, proposal);
    assert.deepEqual(await ports.eventProposals.createOrVerify(proposal), saved);
    const row = await db.executor.query<{ record_json: unknown; claim_text_length: number; support_assessment: string; evidence_label: string }>(
      'SELECT proposal.record_json, length(claim.claim_text) AS claim_text_length, claim.support_assessment, claim.evidence_label ' +
      'FROM waspada.event_proposals proposal JOIN waspada.proposal_claims claim ' +
      'ON claim.dataset_kind=proposal.dataset_kind AND claim.proposal_id=proposal.proposal_id ' +
      'WHERE proposal.dataset_kind=$1 AND proposal.proposal_id=$2',
      [DATASET, proposal.proposal_id],
    );
    assert.equal(row.rows[0]?.claim_text_length, 4000);
    assert.equal(row.rows[0]?.support_assessment, 'uncertain');
    assert.equal(row.rows[0]?.evidence_label, 'under_review');
    assert.deepEqual(row.rows[0]?.record_json, proposal);
    assert.equal((row.rows[0]?.record_json as EventProposal).claims[0]?.event_time.precision, 'date',
      'date-only precision stays date-only in canonical JSON');
    const links = await db.executor.query<{ evidence_kind: string; count: string }>(
      'SELECT evidence_kind, count(*)::text AS count FROM waspada.proposal_claim_evidence ' +
      'WHERE dataset_kind=$1 AND proposal_id=$2 GROUP BY evidence_kind ORDER BY evidence_kind',
      [DATASET, proposal.proposal_id],
    );
    assert.deepEqual(links.rows, [
      { evidence_kind: 'context', count: '2' },
      { evidence_kind: 'contradiction', count: '1' },
      { evidence_kind: 'support', count: '1' },
    ]);
    assert.deepEqual(await publicationCounts(), before, 'draft persistence creates no event, decision or outbox row');
  });

  it('persists empty abstentions and disputed assessments without treating them as publication authority', async () => {
    const abstention = makeProposal({ proposal_id: 'proposal-abstention', claims: [] });
    assert.deepEqual(await ports.eventProposals.createOrVerify(abstention), abstention);
    const disputed = makeProposal({
      proposal_id: 'proposal-disputed',
      claims: [makeClaim({ support_assessment: 'disputed', evidence_label: 'crowdsourced_observation' })],
    });
    assert.deepEqual(await ports.eventProposals.createOrVerify(disputed), disputed);
    assert.deepEqual(await ports.eventProposals.createOrVerify(disputed), disputed);
  });

  it('resolves only exact same-dataset trace, candidate, context and grounded evidence', async () => {
    await assert.rejects(
      ports.eventProposals.createOrVerify(makeProposal({ proposal_id: 'proposal-wrong-trace', trace_id: OTHER_TRACE })),
      EventProposalReferenceError,
    );
    await assert.rejects(
      ports.eventProposals.createOrVerify(makeProposal({ proposal_id: 'proposal-wrong-context', context_id: 'context-absent' })),
      EventProposalReferenceError,
    );
    await assert.rejects(
      ports.eventProposals.createOrVerify(makeProposal({ proposal_id: 'proposal-wrong-candidate', candidate_id: 'candidate-absent' })),
      EventProposalReferenceError,
    );
    const substituted = { ...refs.support, span_end: refs.support.span_end - 1 };
    await assert.rejects(
      ports.eventProposals.createOrVerify(makeProposal({
        proposal_id: 'proposal-unlinked-span',
        claims: [makeClaim({ support: [substituted] })],
      })),
      EventProposalReferenceError,
    );
    const crossDataset = makeProposal({ proposal_id: 'proposal-cross-dataset', dataset_kind: 'live' });
    await assert.rejects(ports.eventProposals.createOrVerify(crossDataset), EventProposalReferenceError);
  });

  it('requires claim-specific support coverage for every support reference and every declared origin', async () => {
    await assert.rejects(
      ports.eventProposals.createOrVerify(makeProposal({
        proposal_id: 'proposal-uncovered-support',
        claims: [makeClaim({ support: [refs.support, refs.support2] })],
      })),
      EventProposalReferenceError,
    );
    await assert.rejects(
      ports.eventProposals.createOrVerify(makeProposal({
        proposal_id: 'proposal-uncovered-origin',
        claims: [makeClaim({ origin_ids: [ORIGIN_A, ORIGIN_B] })],
      })),
      EventProposalReferenceError,
    );
    const covered = makeProposal({
      proposal_id: 'proposal-covered-origins',
      claims: [makeClaim({ support: [refs.support, refs.support2], origin_ids: [ORIGIN_A, ORIGIN_B] })],
    });
    assert.deepEqual(await ports.eventProposals.createOrVerify(covered), covered);
  });

  it('requires an exact persisted event/version candidate link and accepts exact immutable investigation targets', async () => {
    const eventProposal = makeProposal({
      proposal_id: 'proposal-event-target',
      context_id: eventContext.context_id,
      event_id: 'event-proposal',
      base_event_version: 1,
    });
    assert.deepEqual(await ports.eventProposals.createOrVerify(eventProposal), eventProposal);
    await assert.rejects(
      ports.eventProposals.createOrVerify({ ...eventProposal, proposal_id: 'proposal-event-wrong-version', base_event_version: 2 }),
      EventProposalReferenceError,
    );

    await seedInvestigation();
    const initial = makeProposal({ proposal_id: 'proposal-investigation-initial', investigation_id: 'investigation-proposal' });
    assert.deepEqual(await ports.eventProposals.createOrVerify(initial), initial);

    const refreshedContext = await makeContext('context-proposal-refreshed', REFRESH_TRACE);
    await ports.groundingContexts.createOrVerify(refreshedContext);
    await seedCheckpoint(refreshedContext.context_id, REFRESH_TRACE);
    const refreshed = makeProposal({
      proposal_id: 'proposal-investigation-refreshed',
      trace_id: REFRESH_TRACE,
      context_id: refreshedContext.context_id,
      investigation_id: 'investigation-proposal',
    });
    assert.deepEqual(await ports.eventProposals.createOrVerify(refreshed), refreshed);

    const wrongTraceContext = await makeContext('context-proposal-wrong-checkpoint-trace', OTHER_TRACE);
    await ports.groundingContexts.createOrVerify(wrongTraceContext);
    await assert.rejects(
      ports.eventProposals.createOrVerify(makeProposal({
        proposal_id: 'proposal-wrong-checkpoint-trace',
        trace_id: OTHER_TRACE,
        context_id: wrongTraceContext.context_id,
        investigation_id: 'investigation-proposal',
      })),
      EventProposalReferenceError,
    );

    const wrongContext = await makeContext('context-proposal-wrong-checkpoint-context', REFRESH_TRACE);
    await ports.groundingContexts.createOrVerify(wrongContext);
    await assert.rejects(
      ports.eventProposals.createOrVerify(makeProposal({
        proposal_id: 'proposal-wrong-checkpoint-context',
        trace_id: REFRESH_TRACE,
        context_id: wrongContext.context_id,
        investigation_id: 'investigation-proposal',
      })),
      EventProposalReferenceError,
    );
    await assert.rejects(
      ports.eventProposals.createOrVerify(makeProposal({
        proposal_id: 'proposal-wrong-request-target',
        context_id: eventContext.context_id,
        event_id: 'event-proposal',
        base_event_version: 1,
        investigation_id: 'investigation-proposal',
      })),
      EventProposalReferenceError,
    );
  });

  it('conflicts on changed payload, normalized metadata or incomplete child rows without repairing them', async () => {
    const p = makeProposal({ proposal_id: 'proposal-replay-drift' });
    await seedPartialProposal(p, 'disputed');
    await assert.rejects(
      ports.eventProposals.createOrVerify({ ...p, proposed_at: '2026-09-26T10:00:00+00:00' }),
      EventProposalConflictError,
    );
    await assert.rejects(ports.eventProposals.createOrVerify(p), EventProposalConflictError);

    const q = makeProposal({ proposal_id: 'proposal-link-drift' });
    await seedPartialProposal(q, q.claims[0]!.support_assessment);
    await assert.rejects(ports.eventProposals.createOrVerify(q), EventProposalConflictError);
    const rows = await db.executor.query<{ claims: string; evidence: string; origins: string }>(
      'SELECT (SELECT count(*)::text FROM waspada.proposal_claims WHERE dataset_kind=$1 AND proposal_id=$2) AS claims,' +
      '(SELECT count(*)::text FROM waspada.proposal_claim_evidence WHERE dataset_kind=$1 AND proposal_id=$2) AS evidence,' +
      '(SELECT count(*)::text FROM waspada.proposal_claim_origins WHERE dataset_kind=$1 AND proposal_id=$2) AS origins',
      [DATASET, q.proposal_id],
    );
    assert.deepEqual(rows.rows[0], { claims: '1', evidence: '0', origins: '0' },
      'replay detects incomplete append-only rows and never repairs them');
  });

  it('rolls back a failed child insert and redacts the underlying database error', async () => {
    const p = makeProposal({ proposal_id: 'proposal-rollback' });
    const failing: TransactionalSqlExecutor = {
      query: (statement, parameters) => db.executor.query(statement, parameters),
      execute: (statement) => db.executor.execute(statement),
      transaction: <T>(work: (tx: SqlExecutor) => Promise<T>) => db.executor.transaction((realTx) => work({
        query: async <Row extends object>(statement: string, parameters?: readonly unknown[]) => {
          if (statement.includes('INSERT INTO waspada.proposal_claim_origins')) throw new Error('fixture-secret-database-detail');
          return realTx.query<Row>(statement, parameters);
        },
        execute: (statement: string) => realTx.execute(statement),
      })),
    };
    const repo = createSqlEventProposalRepository(failing);
    await assert.rejects(repo.createOrVerify(p), (error: unknown) =>
      error instanceof EventProposalStorageError && !error.message.includes('fixture-secret'));
    const parent = await db.executor.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waspada.event_proposals WHERE dataset_kind=$1 AND proposal_id=$2',
      [DATASET, p.proposal_id],
    );
    assert.equal(parent.rows[0]?.count, '0');
  });

  it('snapshots the caller input before its first await and serializes the identity in the transaction', async () => {
    let started!: () => void;
    let release!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let firstStatement = '';
    const delayed: TransactionalSqlExecutor = {
      query: (statement, parameters) => db.executor.query(statement, parameters),
      execute: (statement) => db.executor.execute(statement),
      transaction: <T>(work: (tx: SqlExecutor) => Promise<T>) => db.executor.transaction((realTx) => {
        let first = true;
        return work({
          query: async <Row extends object>(statement: string, parameters?: readonly unknown[]) => {
            if (first) { first = false; firstStatement = statement; started(); await wait; }
            return realTx.query<Row>(statement, parameters);
          },
          execute: (statement: string) => realTx.execute(statement),
        });
      }),
    };
    const input = makeProposal({ proposal_id: 'proposal-snapshot' });
    const promise = createSqlEventProposalRepository(delayed).createOrVerify(input);
    await startedPromise;
    (input.claims[0] as unknown as { text: string }).text = 'mutated after persistence began';
    release();
    const returned = await promise;
    assert.match(firstStatement, /pg_advisory_xact_lock/);
    assert.equal(returned.claims[0]?.text, 'Fictional road closure observed near the civic hall.');
    const stored = await db.executor.query<{ claim_text: string }>(
      'SELECT claim_text FROM waspada.proposal_claims WHERE dataset_kind=$1 AND proposal_id=$2',
      [DATASET, input.proposal_id],
    );
    assert.equal(stored.rows[0]?.claim_text, 'Fictional road closure observed near the civic hall.');
  });

  it('rejects malformed, unsafe and over-budget inputs before SQL with stable content-free errors', async () => {
    let calls = 0;
    const noSql: TransactionalSqlExecutor = {
      async query() { calls += 1; return { rows: [] }; },
      async execute() { calls += 1; },
      async transaction<T>(work: (tx: SqlExecutor) => Promise<T>) {
        calls += 1;
        return work({ async query() { calls += 1; return { rows: [] }; }, async execute() { calls += 1; } });
      },
    };
    const repo = createSqlEventProposalRepository(noSql);
    const invalids = [
      { ...makeProposal({ proposal_id: 'proposal-bad-date' }), proposed_at: '2026-02-30T10:00:00Z' },
      { ...makeProposal({ proposal_id: 'proposal-bad-nul' }), claims: [makeClaim({ text: 'private\u0000value' })] },
      { ...makeProposal({ proposal_id: 'proposal-bad-extra' }), unexpected: 'private-value' },
      { ...makeProposal({ proposal_id: 'proposal-bad-time-budget' }), model_runs: [{ capability: 'reasoning', model_version: null, prompt_version: null, input_tokens: 8000, output_tokens: 5000 }] },
      { ...makeProposal({ proposal_id: 'proposal-bad-pair' }), event_id: 'event-proposal', base_event_version: null },
    ];
    for (const bad of invalids) {
      await assert.rejects(repo.createOrVerify(bad as EventProposal), (error: unknown) =>
        error instanceof EventProposalValidationError && !error.message.includes('private'));
    }
    await assert.rejects(repo.createOrVerify(makeProposal({
      proposal_id: 'proposal-too-many-evidence',
      claims: [makeClaim({ support: Array.from({ length: 101 }, () => refs.support) })],
    })), EventProposalValidationError);
    await assert.rejects(repo.createOrVerify(makeProposal({
      proposal_id: 'proposal-too-many-claims',
      claims: Array.from({ length: 21 }, (_, i) => makeClaim({ claim_id: 'claim-over-' + i })),
    })), EventProposalValidationError);
    assert.equal(calls, 0, 'invalid input is rejected before starting a transaction');
  });

  it('reapplies only the draft migration while preserving authored rows and public constraints', async () => {
    const p = makeProposal({ proposal_id: 'proposal-migration-replay' });
    await ports.eventProposals.createOrVerify(p);
    const readDraft = () => db.executor.query(
      'SELECT dataset_kind,proposal_id,claim_id,support_assessment,evidence_label,claim_text,record_json ' +
      'FROM waspada.proposal_claims WHERE dataset_kind=$1 AND proposal_id=$2',
      [DATASET, p.proposal_id],
    );
    const before = await readDraft();
    const publicConstraints = await db.executor.query<{ conname: string; definition: string }>(
      'SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint ' +
      'WHERE conrelid=\'waspada.event_claims\'::regclass ORDER BY conname',
    );
    const migration = await readFile(new URL('../migrations/023_l2_event_proposal_writer.sql', import.meta.url), 'utf8');
    await db.executor.transaction((tx) => tx.execute(migration));
    assert.deepEqual((await readDraft()).rows, before.rows);
    assert.deepEqual(
      (await db.executor.query<{ conname: string; definition: string }>(
        'SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint ' +
        'WHERE conrelid=\'waspada.event_claims\'::regclass ORDER BY conname',
      )).rows,
      publicConstraints.rows,
    );
  });

  it('clamps the writer role to exact lineage reads and private draft inserts only', async () => {
    const role = await db.executor.query<{
      rolcanlogin: boolean; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean;
      rolinherit: boolean; rolreplication: boolean; rolbypassrls: boolean;
    }>(
      'SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls ' +
      'FROM pg_roles WHERE rolname=\'waspada_l2_proposal_writer\'',
    );
    assert.deepEqual(role.rows[0], {
      rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
      rolinherit: false, rolreplication: false, rolbypassrls: false,
    });
    const members = await db.executor.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=\'waspada_l2_proposal_writer\') ' +
      'OR roleid=(SELECT oid FROM pg_roles WHERE rolname=\'waspada_l2_proposal_writer\')',
    );
    assert.equal(members.rows[0]?.count, 0);
    const schema = await db.executor.query<{ usage: boolean; create: boolean }>(
      'SELECT has_schema_privilege(\'waspada_l2_proposal_writer\',\'waspada\',\'USAGE\') AS usage,' +
      'has_schema_privilege(\'waspada_l2_proposal_writer\',\'waspada\',\'CREATE\') AS create',
    );
    assert.deepEqual(schema.rows[0], { usage: true, create: false });

    const columns = await db.executor.query<{
      table_name: string; column_name: string; can_select: boolean; can_insert: boolean; can_update: boolean;
    }>(
      "SELECT c.relname AS table_name,a.attname AS column_name," +
      "has_column_privilege('waspada_l2_proposal_writer',c.oid,a.attnum,'SELECT') AS can_select," +
      "has_column_privilege('waspada_l2_proposal_writer',c.oid,a.attnum,'INSERT') AS can_insert," +
      "has_column_privilege('waspada_l2_proposal_writer',c.oid,a.attnum,'UPDATE') AS can_update " +
      "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid " +
      "WHERE n.nspname='waspada' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped",
    );
    const expected = new Set<string>();
    const grant = (table: string, operation: 'select' | 'insert', names: readonly string[]) => {
      for (const column of names) expected.add(table + '.' + column + '.' + operation);
    };
    grant('traces', 'select', ['trace_id', 'dataset_kind']);
    grant('extraction_results', 'select', ['dataset_kind', 'candidate_id']);
    grant('grounding_contexts', 'select', ['dataset_kind', 'context_id', 'trace_id', 'candidate_id']);
    grant('grounding_evidence', 'select', ['dataset_kind', 'context_id', 'evidence_ref_id']);
    grant('evidence_references', 'select', ['dataset_kind', 'evidence_ref_id', 'report_revision_id', 'permitted_text_hash', 'span_start', 'span_end', 'offset_unit', 'relation']);
    grant('evidence_origins', 'select', ['dataset_kind', 'origin_id']);
    grant('origin_evidence', 'select', ['dataset_kind', 'origin_id', 'evidence_ref_id']);
    grant('event_versions', 'select', ['dataset_kind', 'event_id', 'version']);
    grant('grounding_candidate_events', 'select', ['dataset_kind', 'context_id', 'event_id', 'event_version']);
    grant('investigation_requests', 'select', ['dataset_kind', 'investigation_id', 'trace_id', 'candidate_id', 'context_id', 'event_id', 'event_version']);
    grant('investigation_checkpoints', 'select', ['dataset_kind', 'investigation_id', 'trace_id', 'candidate_id', 'context_id', 'event_id', 'event_version', 'checkpoint_id']);
    grant('event_proposals', 'select', ['dataset_kind', 'proposal_id', 'trace_id', 'candidate_id', 'context_id', 'event_id', 'base_event_version', 'investigation_id', 'proposed_at', 'record_json']);
    grant('event_proposals', 'insert', ['dataset_kind', 'proposal_id', 'trace_id', 'candidate_id', 'context_id', 'event_id', 'base_event_version', 'investigation_id', 'proposed_at', 'record_json']);
    grant('proposal_claims', 'select', ['dataset_kind', 'proposal_id', 'claim_id', 'support_assessment', 'evidence_label', 'claim_text', 'record_json']);
    grant('proposal_claims', 'insert', ['dataset_kind', 'proposal_id', 'claim_id', 'support_assessment', 'evidence_label', 'claim_text', 'record_json']);
    grant('proposal_claim_evidence', 'select', ['dataset_kind', 'proposal_id', 'claim_id', 'evidence_kind', 'evidence_ref_id']);
    grant('proposal_claim_evidence', 'insert', ['dataset_kind', 'proposal_id', 'claim_id', 'evidence_kind', 'evidence_ref_id']);
    grant('proposal_claim_origins', 'select', ['dataset_kind', 'proposal_id', 'claim_id', 'origin_id']);
    grant('proposal_claim_origins', 'insert', ['dataset_kind', 'proposal_id', 'claim_id', 'origin_id']);
    const actual = new Set<string>();
    for (const row of columns.rows) {
      if (row.can_update) actual.add(row.table_name + '.' + row.column_name + '.forbidden');
      if (row.can_select) actual.add(row.table_name + '.' + row.column_name + '.select');
      if (row.can_insert) actual.add(row.table_name + '.' + row.column_name + '.insert');
    }
    assert.deepEqual([...actual].sort(), [...expected].sort());

    const tablePrivileges = await db.executor.query<{ can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean }>(
      "SELECT has_table_privilege('waspada_l2_proposal_writer',c.oid,'SELECT') AS can_select," +
      "has_table_privilege('waspada_l2_proposal_writer',c.oid,'INSERT') AS can_insert," +
      "has_table_privilege('waspada_l2_proposal_writer',c.oid,'UPDATE') AS can_update," +
      "has_table_privilege('waspada_l2_proposal_writer',c.oid,'DELETE') AS can_delete " +
      "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='waspada' AND c.relkind IN ('r','p')",
    );
    assert.equal(tablePrivileges.rows.some((row) => row.can_select || row.can_insert || row.can_update || row.can_delete), false);
    await db.executor.query('SET ROLE waspada_l2_proposal_writer');
    try {
      const evidence = await db.executor.query<{ count: string }>(
        'SELECT count(evidence_ref_id)::text AS count FROM waspada.evidence_references WHERE dataset_kind=$1',
        [DATASET],
      );
      assert.ok(Number(evidence.rows[0]?.count) >= 4);
      await assert.rejects(db.executor.query('SELECT permitted_text FROM waspada.report_revisions'));
      await assert.rejects(db.executor.query('UPDATE waspada.proposal_claims SET claim_text=\'not authorized\''));
      await assert.rejects(db.executor.query('INSERT INTO waspada.publication_decisions DEFAULT VALUES'));
    } finally {
      await db.executor.query('RESET ROLE');
    }
  });

  async function seedPartialProposal(p: EventProposal, normalizedAssessment: string): Promise<void> {
    await db.executor.query(
      'INSERT INTO waspada.event_proposals (dataset_kind,proposal_id,trace_id,candidate_id,context_id,event_id,base_event_version,investigation_id,proposed_at,record_json) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::jsonb)',
      [p.dataset_kind, p.proposal_id, p.trace_id, p.candidate_id, p.context_id, p.event_id,
        p.base_event_version, p.investigation_id, p.proposed_at, JSON.stringify(p)],
    );
    const claim = p.claims[0]!;
    await db.executor.query(
      'INSERT INTO waspada.proposal_claims (dataset_kind,proposal_id,claim_id,support_assessment,evidence_label,claim_text,record_json) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)',
      [p.dataset_kind, p.proposal_id, claim.claim_id, normalizedAssessment, claim.evidence_label, claim.text, JSON.stringify(claim)],
    );
  }

  async function seedFixture(): Promise<Record<'support' | 'support2' | 'contradiction' | 'updates' | 'context', ProposalEvidenceReference>> {
    for (const traceId of [BASE_TRACE, REFRESH_TRACE, OTHER_TRACE]) {
      await db.executor.query(
        'INSERT INTO waspada.traces (trace_id,dataset_kind,started_at,outcome,metadata) ' +
        'VALUES ($1,$2,$3,\'open\',\'{"fixture":"authored synthetic"}\'::jsonb)',
        [traceId, DATASET, WHEN],
      );
    }
    await db.executor.query(
      'INSERT INTO waspada.source_registry (source_id,trace_id,registry_version,display_name,source_kind,remit,access_method,' +
      'approved_hosts,access_restrictions,reuse_basis,registry_status,approval_status,health_status,auto_acquisition_enabled,auto_publication_policy) ' +
      'VALUES (\'source-proposal\', $1, 1, \'Synthetic proposal fixture\', \'other\', ARRAY[\'test\'], \'manual_fixture\', ' +
      'ARRAY[]::text[], ARRAY[\'synthetic only\'], ARRAY[\'authored fixture\'], \'active\', \'approved\', \'unknown\', false, \'never\')',
      [BASE_TRACE],
    );
    await db.executor.query(
      'INSERT INTO waspada.report_revisions (dataset_kind,report_revision_id,trace_id,source_id,canonical_url,source_revision_key,' +
      'content_hash,permitted_text,permitted_text_hash,normalization_version,retrieved_at,revision_status,record_json) ' +
      'VALUES ($1,$2,$3,\'source-proposal\',\'https://synthetic.invalid/proposal\',NULL,$4,$5,$6,\'normalization-test-v1\',$7,\'retracted\',\'{"fixture":"authored synthetic"}\'::jsonb)',
      [DATASET, ID, BASE_TRACE, sha256('synthetic raw fixture'), TEXT, HASH, WHEN],
    );
    await db.executor.query(
      'INSERT INTO waspada.extraction_results (dataset_kind,candidate_id,trace_id,report_revision_id,category,record_json) ' +
      'VALUES ($1,$2,$3,$4,NULL,\'{"fixture":"authored synthetic candidate"}\'::jsonb)',
      [DATASET, CANDIDATE, BASE_TRACE, ID],
    );
    const relationDefs = [
      ['support', 'supports', 0, 20],
      ['support2', 'supports', 20, 35],
      ['contradiction', 'contradicts', 0, 20],
      ['updates', 'updates', 0, 20],
      ['context', 'context', 0, 20],
    ] as const;
    const result: Record<string, ProposalEvidenceReference> = {};
    for (const [key, relation, spanStart, spanEnd] of relationDefs) {
      const ref: ProposalEvidenceReference = {
        report_revision_id: ID, permitted_text_hash: HASH,
        span_start: spanStart, span_end: spanEnd,
        offset_unit: 'unicode_code_points', relation,
      };
      await ports.reportRevisions.createEvidenceReference({
        datasetKind: DATASET, traceId: BASE_TRACE, reportRevisionId: ID,
        permittedTextHash: HASH, spanStart, spanEnd, relation,
      });
      result[key] = ref;
    }
    for (const [originId, independence] of [[ORIGIN_A, 'unknown'], [ORIGIN_B, 'dependent']] as const) {
      await db.executor.query(
        'INSERT INTO waspada.evidence_origins (dataset_kind,origin_id,trace_id,origin_kind,lineage_relation,independence_status,record_json) ' +
        'VALUES ($1,$2,$3,\'unknown\',\'unknown\',$4,\'{"fixture":"authored synthetic"}\'::jsonb)',
        [DATASET, originId, BASE_TRACE, independence],
      );
    }
    const supportId = await evidenceId(result.support);
    const support2Id = await evidenceId(result.support2);
    await db.executor.query(
      'INSERT INTO waspada.origin_evidence (dataset_kind,origin_id,evidence_ref_id) VALUES ($1,$2,$3::bigint),($1,$4,$5::bigint)',
      [DATASET, ORIGIN_A, supportId, ORIGIN_B, support2Id],
    );
    return result as Record<'support' | 'support2' | 'contradiction' | 'updates' | 'context', ProposalEvidenceReference>;
  }

  async function makeContext(
    contextId: string,
    traceId: string,
    candidateEvents: readonly { readonly event_id: string; readonly event_version: number }[] = [],
  ): Promise<GroundingContextRecord> {
    return {
      schema_version: '2.0', trace_id: traceId, record_type: 'GroundingContext',
      dataset_kind: DATASET, context_id: contextId, candidate_id: CANDIDATE,
      evidence: [refs.support, refs.support2, refs.contradiction, refs.updates, refs.context].map((ref) => ({
        report_revision_id: ref.report_revision_id, permitted_text_hash: ref.permitted_text_hash,
        span_start: ref.span_start, span_end: ref.span_end, offset_unit: ref.offset_unit, relation: ref.relation,
      })),
      revision_states: [{ report_revision_id: ID, revision_status: 'retracted' }],
      candidate_events: [...candidateEvents], prior_decision_ids: [],
      missing_fields: ['current_service_status'], conflicts: ['authored contrary context retained'],
      retrieval_version: 'fixture-retrieval-v1', index_version: 'fixture-index-v1', sufficient: false,
    };
  }

  async function seedEvent(): Promise<void> {
    await db.executor.query(
      'INSERT INTO waspada.event_proposals (dataset_kind,proposal_id,trace_id,candidate_id,context_id,event_id,base_event_version,investigation_id,proposed_at,record_json) ' +
      'VALUES ($1,\'proposal-event-fixture\',$2,$3,$4,NULL,NULL,NULL,$5::timestamptz,\'{}\'::jsonb)',
      [DATASET, BASE_TRACE, CANDIDATE, context.context_id, WHEN],
    );
    await db.executor.transaction(async (tx) => {
      await tx.query(
        'INSERT INTO waspada.publication_decisions (dataset_kind,decision_id,trace_id,proposal_id,policy_version,event_id,event_version,reviewer_id,decided_at,record_json) ' +
        'VALUES ($1,\'decision-event-fixture\',$2,\'proposal-event-fixture\',\'fixture-policy\',\'event-proposal\',1,\'authored-fixture\', $3::timestamptz,\'{}\'::jsonb)',
        [DATASET, BASE_TRACE, WHEN],
      );
      await tx.query(
        'INSERT INTO waspada.event_versions (dataset_kind,event_id,version,trace_id,supersedes_version,title,summary,category,lifecycle,publication_status,' +
        'withdrawal_reason,publication_decision_id,published_at,withdrawn_at,record_json) ' +
        'VALUES ($1,\'event-proposal\',1,$2,NULL,\'Fictional withdrawn event\',\'Authored synthetic fixture only\',\'transport_road_incidents\',\'unknown\',\'withdrawn\',' +
        '\'other\',\'decision-event-fixture\',NULL,$3::timestamptz,\'{"claims":[],"impact_refs":[]}\'::jsonb)',
        [DATASET, BASE_TRACE, WHEN],
      );
    });
  }

  async function seedInvestigation(): Promise<void> {
    await db.executor.query(
      'INSERT INTO waspada.investigation_requests (dataset_kind,investigation_id,trace_id,candidate_id,context_id,event_id,event_version,questions,' +
      'budget_policy_version,limit_tool_attempts,limit_reasoning_turns,limit_active_seconds,limit_model_tokens,requested_at,record_json) ' +
      'VALUES ($1,\'investigation-proposal\',$2,$3,$4,NULL,NULL,ARRAY[\'service status\'],\'fixture-budget-v1\',5,4,60,12000,$5::timestamptz,\'{"fixture":"authored synthetic"}\'::jsonb)',
      [DATASET, BASE_TRACE, CANDIDATE, context.context_id, WHEN],
    );
  }

  async function seedCheckpoint(contextId: string, traceId: string): Promise<void> {
    await db.executor.query(
      'INSERT INTO waspada.investigation_checkpoints (dataset_kind,checkpoint_id,investigation_id,checkpoint_version,trace_id,candidate_id,context_id,' +
      'event_id,event_version,case_status,stop_reason,budget_policy_version,limit_tool_attempts,limit_reasoning_turns,limit_active_seconds,limit_model_tokens,' +
      'attempts,reasoning_runs,created_at,updated_at,completed_at,record_json) ' +
      'VALUES ($1,\'checkpoint-proposal-refresh\',\'investigation-proposal\',2,$2,$3,$4,NULL,NULL,\'paused\',\'no_progress\',\'fixture-budget-v1\',5,4,60,12000,' +
      '\'[]\'::jsonb,\'[]\'::jsonb,$5::timestamptz,$5::timestamptz,NULL,\'{"fixture":"authored synthetic"}\'::jsonb)',
      [DATASET, traceId, CANDIDATE, contextId, WHEN],
    );
  }

  async function evidenceId(ref: ProposalEvidenceReference): Promise<string> {
    const row = await db.executor.query<{ evidence_ref_id: string }>(
      'SELECT evidence_ref_id::text AS evidence_ref_id FROM waspada.evidence_references WHERE dataset_kind=$1 ' +
      'AND report_revision_id=$2 AND permitted_text_hash=$3 AND span_start=$4 AND span_end=$5 AND relation=$6',
      [DATASET, ref.report_revision_id, ref.permitted_text_hash, ref.span_start, ref.span_end, ref.relation],
    );
    assert.equal(row.rows.length, 1);
    return row.rows[0]!.evidence_ref_id;
  }
  async function publicationCounts() {
    return db.executor.query<{ event_versions: string; decisions: string; outbox: string }>(
      'SELECT (SELECT count(*)::text FROM waspada.event_versions) AS event_versions,' +
      '(SELECT count(*)::text FROM waspada.publication_decisions) AS decisions,' +
      '(SELECT count(*)::text FROM waspada.publication_outbox) AS outbox',
    ).then((x) => x.rows[0]);
  }
});

function makeProposal(overrides: Partial<EventProposal> = {}): EventProposal {
  return {
    schema_version: '2.0', trace_id: BASE_TRACE, record_type: 'EventProposal', dataset_kind: DATASET,
    proposal_id: 'proposal-default', candidate_id: CANDIDATE, context_id: 'context-proposal',
    event_id: null, base_event_version: null, investigation_id: null,
    claims: [makeClaim()], unresolved_fields: [], model_runs: [],
    proposed_at: WHEN, ...overrides,
  };
}
function makeClaim(overrides: Partial<ProposalClaim> = {}): ProposalClaim {
  return {
    claim_id: 'claim-default',
    text: 'Fictional road closure observed near the civic hall.',
    event_time: { precision: 'unknown', start: null, end: null },
    validity: { valid_from: null, valid_until: null },
    scope: { place_ids: [], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [] },
    qualifiers: [], support: [refsSupport()], contradictions: [], context_evidence: [],
    origin_ids: [ORIGIN_A], support_assessment: 'supported', evidence_label: 'attributed_report',
    ...overrides,
  };
}
function refsSupport(): ProposalEvidenceReference {
  return { report_revision_id: ID, permitted_text_hash: HASH, span_start: 0, span_end: 20, offset_unit: 'unicode_code_points', relation: 'supports' };
}
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
