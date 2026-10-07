import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  createSqlEventProposalReader,
  EventProposalReaderError,
  type EventProposal,
  type ProposalClaim,
} from '../src/event-proposals.js';
import type { SqlExecutor } from '../src/sql.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const WHEN = '2026-10-07T00:00:00Z';
const TEXT = 'Authored synthetic fixture only.';
const SUPPORT_HASH = 'a'.repeat(64);

describe('L4 persisted EventProposal reader', () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(db.executor, migrations);
  });

  after(async () => db?.close());

  it('returns the strictly validated stored live proposal', async () => {
    const proposal = await seedProposal('proposal-reader-valid');
    const reader = createSqlEventProposalReader(db.executor);

    assert.deepEqual(await reader.readLive(proposal.proposal_id), proposal);
  });

  it('returns null for an absent live identifier and for a synthetic-only proposal', async () => {
    const synthetic = await seedProposal('proposal-reader-synthetic', 'synthetic');
    const reader = createSqlEventProposalReader(db.executor);

    assert.equal(await reader.readLive('proposal-reader-absent'), null);
    assert.equal(await reader.readLive(synthetic.proposal_id), null);
  });

  it('reads the proposal under only the existing L4 publication writer role', async () => {
    const proposal = await seedProposal('proposal-reader-l4-role');
    const reader = createSqlEventProposalReader(db.executor);
    await db.executor.execute('SET ROLE waspada_l4_publication_writer');
    try {
      const activeRole = await db.executor.query<{ current_user: string }>('SELECT current_user');
      assert.equal(activeRole.rows[0]?.current_user, 'waspada_l4_publication_writer');
      assert.deepEqual(await reader.readLive(proposal.proposal_id), proposal);
      await assert.rejects(db.executor.query('SELECT permitted_text FROM waspada.report_revisions'));
    } finally {
      await db.executor.execute('RESET ROLE');
    }
  });

  it('rejects every persisted identity column that disagrees with the validated JSON record', async () => {
    const cases: readonly {
      readonly suffix: string;
      readonly mutate: (proposal: EventProposal) => EventProposal;
    }[] = [
      { suffix: 'dataset', mutate: (proposal) => ({ ...proposal, dataset_kind: 'synthetic' }) },
      { suffix: 'proposal', mutate: (proposal) => ({ ...proposal, proposal_id: 'proposal-reader-forged-id' }) },
      { suffix: 'trace', mutate: (proposal) => ({ ...proposal, trace_id: 'trace-reader-forged' }) },
      { suffix: 'candidate', mutate: (proposal) => ({ ...proposal, candidate_id: 'candidate-reader-forged' }) },
      { suffix: 'context', mutate: (proposal) => ({ ...proposal, context_id: 'context-reader-forged' }) },
      {
        suffix: 'target',
        mutate: (proposal) => ({ ...proposal, event_id: 'event-reader-forged', base_event_version: 1 }),
      },
    ];

    const reader = createSqlEventProposalReader(db.executor);
    for (const testCase of cases) {
      const proposal = await seedProposal(
        'proposal-reader-mismatch-' + testCase.suffix,
        'live',
        testCase.mutate,
      );
      await assert.rejects(
        reader.readLive(proposal.proposal_id),
        (error: unknown) => error instanceof EventProposalReaderError
          && error.failure === 'invalid_persisted_proposal'
          && error.message === 'event_proposal_reader_error',
        testCase.suffix,
      );
    }
  });

  it('rejects a malformed schema-2.0 persisted document without exposing its contents', async () => {
    const proposal = await seedProposal(
      'proposal-reader-malformed',
      'live',
      () => ({ private_text: 'not a proposal' }),
    );

    const reader = createSqlEventProposalReader(db.executor);
    await assert.rejects(
      reader.readLive(proposal.proposal_id),
      (error: unknown) => error instanceof EventProposalReaderError
        && error.failure === 'invalid_persisted_proposal'
        && error.message === 'event_proposal_reader_error'
        && !error.message.includes('private_text'),
    );
  });

  it('rejects malformed identifiers before SQL and maps SQL failures to a fixed error', async () => {
    let calls = 0;
    const failingExecutor: SqlExecutor = {
      async query<Row extends object>(): Promise<{ readonly rows: readonly Row[] }> {
        calls += 1;
        throw new Error('private database detail');
      },
      async execute() {},
    };
    const reader = createSqlEventProposalReader(failingExecutor);

    await assert.rejects(reader.readLive('not an identifier'), (error: unknown) =>
      error instanceof EventProposalReaderError && error.failure === 'invalid_proposal_id'
        && error.message === 'event_proposal_reader_error');
    assert.equal(calls, 0);

    await assert.rejects(reader.readLive('proposal-reader-query-failure'), (error: unknown) =>
      error instanceof EventProposalReaderError && error.failure === 'proposal_read_failed'
        && error.message === 'event_proposal_reader_error' && !error.message.includes('private'));
    assert.equal(calls, 1);
  });

  async function seedProposal(
    proposalId: string,
    datasetKind: 'live' | 'synthetic' = 'live',
    recordOverride?: (proposal: EventProposal) => unknown,
  ): Promise<EventProposal> {
    const traceId = 'trace-' + proposalId;
    const sourceId = 'source-' + proposalId;
    const revisionId = 'revision-' + proposalId;
    const candidateId = 'candidate-' + proposalId;
    const contextId = 'context-' + proposalId;
    const proposal = makeProposal({
      proposal_id: proposalId,
      dataset_kind: datasetKind,
      trace_id: traceId,
      candidate_id: candidateId,
      context_id: contextId,
      claims: [makeClaim()],
    });

    await db.executor.query(
      'INSERT INTO waspada.traces (trace_id,dataset_kind,started_at,outcome,metadata) ' +
      'VALUES ($1,$2,$3,\'open\',$4::jsonb)',
      [traceId, datasetKind, WHEN, JSON.stringify({ fixture: 'authored synthetic test only' })],
    );
    await db.executor.query(
      'INSERT INTO waspada.source_registry ' +
      '(source_id,trace_id,registry_version,display_name,source_kind,remit,access_method,approved_hosts,' +
      'access_restrictions,reuse_basis,registry_status,approval_status,health_status,auto_acquisition_enabled,auto_publication_policy) ' +
      'VALUES ($1,$2,1,\'Synthetic reader fixture\',\'other\',ARRAY[\'test only\'],\'manual_fixture\',' +
      'ARRAY[]::text[],ARRAY[\'authored fixture\'],ARRAY[\'test only\'],\'active\',\'pending\',\'unknown\',false,\'never\')',
      [sourceId, traceId],
    );
    await db.executor.query(
      'INSERT INTO waspada.report_revisions ' +
      '(dataset_kind,report_revision_id,trace_id,source_id,canonical_url,content_hash,permitted_text,' +
      'permitted_text_hash,normalization_version,retrieved_at,revision_status,record_json) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,\'fixture-normalization-v1\',$9,\'unreviewed\',$10::jsonb)',
      [datasetKind, revisionId, traceId, sourceId, 'https://example.invalid/authored-fixture',
        SUPPORT_HASH, TEXT, SUPPORT_HASH, WHEN, JSON.stringify({ fixture: 'authored synthetic only' })],
    );
    await db.executor.query(
      'INSERT INTO waspada.extraction_results ' +
      '(dataset_kind,candidate_id,trace_id,report_revision_id,category,record_json) ' +
      'VALUES ($1,$2,$3,$4,NULL,$5::jsonb)',
      [datasetKind, candidateId, traceId, revisionId, JSON.stringify({ fixture: 'authored synthetic only' })],
    );
    await db.executor.query(
      'INSERT INTO waspada.grounding_contexts ' +
      '(dataset_kind,context_id,trace_id,candidate_id,retrieval_version,index_version,sufficient,record_json) ' +
      'VALUES ($1,$2,$3,$4,\'hybrid-evidence-v1\',\'fixture-index-v1\',false,$5::jsonb)',
      [datasetKind, contextId, traceId, candidateId, JSON.stringify({ fixture: 'authored synthetic only' })],
    );
    await db.executor.query(
      'INSERT INTO waspada.event_proposals ' +
      '(dataset_kind,proposal_id,trace_id,candidate_id,context_id,event_id,base_event_version,' +
      'investigation_id,proposed_at,record_json) VALUES ($1,$2,$3,$4,$5,NULL,NULL,NULL,$6::timestamptz,$7::jsonb)',
      [datasetKind, proposalId, traceId, candidateId, contextId, WHEN,
        JSON.stringify(recordOverride ? recordOverride(proposal) : proposal)],
    );
    return proposal;
  }
});

function makeProposal(overrides: Partial<EventProposal> = {}): EventProposal {
  return {
    schema_version: '2.0',
    trace_id: 'trace-reader-default',
    record_type: 'EventProposal',
    dataset_kind: 'live',
    proposal_id: 'proposal-reader-default',
    candidate_id: 'candidate-reader-default',
    context_id: 'context-reader-default',
    event_id: null,
    base_event_version: null,
    investigation_id: null,
    claims: [],
    unresolved_fields: [],
    model_runs: [],
    proposed_at: WHEN,
    ...overrides,
  };
}

function makeClaim(overrides: Partial<ProposalClaim> = {}): ProposalClaim {
  return {
    claim_id: 'claim-001',
    text: 'A fictional closure remains in effect.',
    event_time: { precision: 'unknown', start: null, end: null },
    validity: { valid_from: null, valid_until: null },
    scope: {
      place_ids: ['place-reader-fixture'],
      service_ids: [],
      institution_ids: [],
      audience_ids: [],
      geometry_ids: [],
    },
    qualifiers: [],
    support: [{
      report_revision_id: 'revision-reader-fixture',
      permitted_text_hash: SUPPORT_HASH,
      span_start: 0,
      span_end: 6,
      offset_unit: 'unicode_code_points',
      relation: 'supports',
    }],
    contradictions: [],
    context_evidence: [],
    origin_ids: ['origin-reader-fixture'],
    support_assessment: 'supported',
    evidence_label: 'under_review',
    ...overrides,
  };
}
