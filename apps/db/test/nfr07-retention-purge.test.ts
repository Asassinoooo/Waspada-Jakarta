import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createAccountStore } from '../src/accounts.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import type { SqlExecutor } from '../src/sql.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

/**
 * NFR-07 F-39, F-40, F-41 (ADR-005): the retention purge. One call to waspada.purge_expired_retention, run as the
 * waspada_retention_purger role, nulls source text past its rule, deletes the vectors of text that was removed or
 * retracted, deletes audit rows older than 24 months and deletes expired triage caches. It never deletes a published
 * version, a referenced row or a young audit row, and the append-only guards refuse every other change. Synthetic
 * fixtures only (PGlite): no network, no model, no real source text.
 */

const NOW = '2026-11-19T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const PURGER = 'waspada_retention_purger';
const FICTION = '{"fixture":"authored-fiction-only"}';
const PURGE_CALL = `SELECT source_text_nulled::text, vectors_removed::text, audit_records_removed::text,
       account_admin_audit_removed::text, triage_decisions_removed::text
  FROM waspada.purge_expired_retention($1::timestamptz)`;
const PROTECTED_TABLES = [
  'event_versions', 'event_claims', 'event_claim_evidence', 'evidence_references', 'publication_decisions',
  'proposal_claims', 'event_proposals', 'report_revisions', 'source_registry', 'public_attribution_review_decisions',
] as const;

/** Fictional text per revision. ASCII only, so span lengths in code points equal JavaScript lengths. */
const TEXT: Readonly<Record<string, string>> = {
  'rev-expired-365': 'Teks fiksi uji retensi lewat 365 hari.',
  'rev-expired-90': 'Teks fiksi uji retensi lewat 90 hari tanpa acuan.',
  'rev-fresh': 'Teks fiksi uji retensi baru.',
  'rev-published-current': 'Teks fiksi uji retensi dikutip peristiwa terbit.',
  'rev-published-cap': 'Teks fiksi uji retensi dikutip peristiwa terbit lewat 365 hari.',
  'rev-open-job': 'Teks fiksi uji retensi menunggu pekerjaan AI.',
  'rev-undecided-proposal': 'Teks fiksi uji retensi dipakai usulan belum diputuskan.',
  'rev-retracted': 'Teks fiksi uji retensi ditarik sumber.',
  'rev-vector-current': 'Teks fiksi uji retensi vektor terkini.',
  'rev-superseded-old': 'Teks fiksi uji retensi versi lama yang sudah digantikan.',
  'rev-superseded-recent': 'Teks fiksi uji retensi versi lama yang baru digantikan.',
  'rev-superseded-new': 'Teks fiksi uji retensi versi pengganti pertama.',
  'rev-superseded-new-2': 'Teks fiksi uji retensi versi pengganti kedua.',
};

interface PurgeCounts {
  readonly source_text_nulled: string;
  readonly vectors_removed: string;
  readonly audit_records_removed: string;
  readonly account_admin_audit_removed: string;
  readonly triage_decisions_removed: string;
}

interface PublishedVersion {
  readonly eventId: string;
  readonly version: number;
  readonly publishedAt: string;
  /** Each revision named here gets one evidence reference, and the version's single claim cites all of them. */
  readonly revisionIds: readonly string[];
}

let database: TestDatabase;
let userId: string;
let firstPurge: PurgeCounts;
const protectedBefore = new Map<string, string>();

const ago = (ms: number): string => new Date(Date.parse(NOW) - ms).toISOString();
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function textOf(revisionId: string): string {
  const text = TEXT[revisionId];
  if (text === undefined) throw new Error(`no fixture text for ${revisionId}`);
  return text;
}

/** Runs the purge as the purger role for one statement, then returns to the owner role. */
async function purgeAs(now: string): Promise<PurgeCounts> {
  await database.executor.execute(`SET ROLE ${PURGER}`);
  try {
    const result = await database.executor.query<PurgeCounts>(PURGE_CALL, [now]);
    const row = result.rows[0];
    assert.ok(row, 'the purge returns one row of counts');
    return row;
  } finally {
    await database.executor.execute('RESET ROLE');
  }
}

async function countRows(table: string): Promise<string> {
  assert.ok((PROTECTED_TABLES as readonly string[]).includes(table), `${table} is a protected table`);
  const result = await database.executor.query<{ n: string }>(`SELECT count(*)::text AS n FROM waspada.${table}`);
  return result.rows[0]?.n ?? '';
}

async function insertRevision(id: string, retrievedAt: string, revisionStatus = 'unreviewed'): Promise<void> {
  const text = textOf(id);
  await database.executor.query(
    `INSERT INTO waspada.report_revisions (dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
       content_hash, permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json)
     VALUES ('live', $1, 'trace-retention', 'source-retention', $2, $3, $4, $5, 'retention-test-v1', $6, $7, $8::jsonb)`,
    [id, `https://${id}.invalid/fixture`, sha(`content:${id}`), text, sha(text), retrievedAt, revisionStatus, FICTION],
  );
}

/** A chunk over the whole text, and one available embedding run with its vector. */
async function insertVector(revisionId: string, runCreatedAt: string): Promise<void> {
  const text = textOf(revisionId);
  const chunkHash = sha(`chunk:${revisionId}`);
  await database.executor.query(
    `INSERT INTO waspada.evidence_chunks (dataset_kind, chunk_id, trace_id, report_revision_id, permitted_text_hash,
       span_start, span_end, offset_unit, chunker_version, chunk_text_hash, status)
     VALUES ('live', $1, 'trace-retention', $2, $3, 0, $4, 'unicode_code_points', 'retention-test-v1', $5, 'active')`,
    [`chunk-${revisionId}`, revisionId, sha(text), text.length, chunkHash],
  );
  await database.executor.query(
    `INSERT INTO waspada.embedding_runs (dataset_kind, embedding_run_id, trace_id, chunk_id, capability, provider,
       model_version, dimensions, distance_metric, vector_index_version, input_text_hash, status, created_at)
     VALUES ('live', $1, 'trace-retention', $2, 'embedding', 'synthetic-test', 'retention-test-model', 3, 'cosine',
       'retention-test-index', $3, 'available', $4)`,
    [`run-${revisionId}`, `chunk-${revisionId}`, chunkHash, runCreatedAt],
  );
  await database.executor.query(
    `INSERT INTO waspada.embedding_vectors (dataset_kind, embedding_run_id, dimensions, embedding)
     VALUES ('live', $1, 3, '[0.1,0.2,0.3]'::vector)`,
    [`run-${revisionId}`],
  );
}

async function insertEvidence(executor: SqlExecutor, revisionId: string): Promise<number> {
  const result = await executor.query<{ evidence_ref_id: string }>(
    `INSERT INTO waspada.evidence_references (dataset_kind, trace_id, report_revision_id, permitted_text_hash,
       span_start, span_end, offset_unit, relation)
     VALUES ('live', 'trace-retention', $1, $2, 0, $3, 'unicode_code_points', 'supports')
     RETURNING evidence_ref_id::text AS evidence_ref_id`,
    [revisionId, sha(textOf(revisionId)), textOf(revisionId).length],
  );
  return Number(result.rows[0]?.evidence_ref_id);
}

/** One published version: candidate, grounding, proposal, decision, version row, claim and its evidence. */
async function insertPublishedVersion(executor: SqlExecutor, spec: PublishedVersion): Promise<void> {
  const tag = `${spec.eventId}-v${spec.version}`;
  const candidateId = `candidate-${tag}`;
  const contextId = `context-${tag}`;
  const proposalId = `proposal-${tag}`;
  const decisionId = `decision-${tag}`;
  const claimId = `claim-${tag}`;
  const supersedes = spec.version > 1 ? spec.version - 1 : null;
  const [firstRevision] = spec.revisionIds;
  assert.ok(firstRevision, 'a version cites at least one revision');

  await executor.query(
    `INSERT INTO waspada.extraction_results (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
     VALUES ('live', $1, 'trace-retention', $2, 'group_specific_critical_notices', $3::jsonb)`,
    [candidateId, firstRevision, FICTION],
  );
  await executor.query(
    `INSERT INTO waspada.grounding_contexts (dataset_kind, context_id, trace_id, candidate_id, retrieval_version,
       index_version, sufficient, record_json)
     VALUES ('live', $1, 'trace-retention', $2, 'retention-test-v1', 'retention-test-index', true, $3::jsonb)`,
    [contextId, candidateId, FICTION],
  );
  await executor.query(
    `INSERT INTO waspada.event_proposals (dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id,
       base_event_version, proposed_at, record_json)
     VALUES ('live', $1, 'trace-retention', $2, $3, $4, $5, $6, $7::jsonb)`,
    [proposalId, candidateId, contextId, supersedes === null ? null : spec.eventId, supersedes, spec.publishedAt, FICTION],
  );
  await executor.query(
    `INSERT INTO waspada.publication_decisions (dataset_kind, decision_id, trace_id, proposal_id, policy_version,
       event_id, event_version, decided_at, record_json)
     VALUES ('live', $1, 'trace-retention', $2, 'retention-test-policy-v1', $3, $4, $5, $6::jsonb)`,
    [decisionId, proposalId, spec.eventId, spec.version, spec.publishedAt, FICTION],
  );
  await executor.query(
    `INSERT INTO waspada.event_versions (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary,
       category, lifecycle, publication_status, withdrawal_reason, publication_decision_id, published_at, withdrawn_at, record_json)
     VALUES ('live', $1, $2, 'trace-retention', $3, $4, 'Ringkasan fiksi untuk uji retensi.',
       'group_specific_critical_notices', 'unknown', 'published', NULL, $5, $6, NULL, $7::jsonb)`,
    [spec.eventId, spec.version, supersedes, `Peristiwa fiksi ${spec.eventId}`, decisionId, spec.publishedAt,
      JSON.stringify({
        schema_version: '2.0', trace_id: 'trace-retention', record_type: 'Event', dataset_kind: 'live',
        event_id: spec.eventId, version: spec.version, supersedes_version: supersedes,
        title: `Peristiwa fiksi ${spec.eventId}`, summary: 'Ringkasan fiksi untuk uji retensi.',
        category: 'group_specific_critical_notices', tags: [], lifecycle: 'unknown',
        freshness: null, event_time: null, validity: null, scope: null,
        claims: [{ claim_id: claimId }], impact_refs: [],
        publication_status: 'published', withdrawal_reason: null,
        publication_decision_id: decisionId, published_at: spec.publishedAt, withdrawn_at: null,
      })],
  );
  await executor.query(
    `INSERT INTO waspada.event_claims (dataset_kind, event_id, event_version, claim_id, publication_status, claim_text,
       evidence_label, record_json)
     VALUES ('live', $1, $2, $3, 'published', 'Klaim fiksi uji retensi.', 'attributed_report', $4::jsonb)`,
    [spec.eventId, spec.version, claimId, FICTION],
  );
  for (const revisionId of spec.revisionIds) {
    const evidenceRefId = await insertEvidence(executor, revisionId);
    await executor.query(
      `INSERT INTO waspada.event_claim_evidence (dataset_kind, event_id, event_version, claim_id, evidence_kind, evidence_ref_id)
       VALUES ('live', $1, $2, $3, 'support', $4)`,
      [spec.eventId, spec.version, claimId, evidenceRefId],
    );
  }
}

describe('NFR-07 F-39..F-41: retention purge (ADR-005)', () => {
  before(async () => {
    database = await createTestDatabase();
    await applyMigrations(database.executor, await readMigrations(new URL('../migrations/', import.meta.url)));
    await database.executor.query("INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')");
    await database.executor.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
       VALUES ('trace-retention', 'live', $1, 'succeeded', $2::jsonb)`,
      [ago(300 * DAY), FICTION],
    );
    await database.executor.query(
      `INSERT INTO waspada.source_registry (source_id, trace_id, registry_version, display_name, source_kind, remit,
         access_method, approved_hosts, access_restrictions, reuse_basis, registry_status, approval_status,
         health_status, auto_acquisition_enabled, auto_publication_policy)
       VALUES ('source-retention', 'trace-retention', 1, 'Sumber Fiksi Uji', 'other', ARRAY['test fixture'],
         'manual_fixture', ARRAY['retention.invalid'], ARRAY['fictional test only'], ARRAY['test only'],
         'active', 'approved', 'unknown', false, 'never')`,
    );

    // Source text, each row aged by what the ADR says about it.
    await insertRevision('rev-expired-365', ago(400 * DAY));
    await insertRevision('rev-expired-90', ago(120 * DAY));
    await insertRevision('rev-fresh', ago(10 * DAY));
    await insertRevision('rev-published-current', ago(200 * DAY));
    await insertRevision('rev-published-cap', ago(400 * DAY));
    await insertRevision('rev-open-job', ago(200 * DAY));
    await insertRevision('rev-undecided-proposal', ago(200 * DAY));
    await insertRevision('rev-retracted', ago(10 * DAY), 'retracted');
    await insertRevision('rev-vector-current', ago(10 * DAY));
    await insertRevision('rev-superseded-old', ago(200 * DAY));
    await insertRevision('rev-superseded-recent', ago(200 * DAY));
    await insertRevision('rev-superseded-new', ago(120 * DAY));
    await insertRevision('rev-superseded-new-2', ago(30 * DAY));

    // Vectors. The run of current text is 30 hours old: it is kept by its text, not by its age.
    await insertVector('rev-expired-365', ago(400 * DAY));
    await insertVector('rev-retracted', ago(10 * DAY));
    await insertVector('rev-vector-current', ago(30 * HOUR));

    await database.executor.transaction(async (tx) => {
      await tx.execute('SET CONSTRAINTS ALL DEFERRED');
      // Current published event, citing a 200-day revision and a 400-day revision (the 365-day cap applies).
      await insertPublishedVersion(tx, {
        eventId: 'event-pub-1', version: 1, publishedAt: ago(20 * DAY),
        revisionIds: ['rev-published-current', 'rev-published-cap'],
      });
      // Superseded 120 days ago: its v1 citation has passed 90 days since it stopped being current.
      await insertPublishedVersion(tx, {
        eventId: 'event-sup-old', version: 1, publishedAt: ago(200 * DAY), revisionIds: ['rev-superseded-old'],
      });
      await insertPublishedVersion(tx, {
        eventId: 'event-sup-old', version: 2, publishedAt: ago(120 * DAY), revisionIds: ['rev-superseded-new'],
      });
      // Superseded 30 days ago: its v1 citation is still inside the 90 days.
      await insertPublishedVersion(tx, {
        eventId: 'event-sup-recent', version: 1, publishedAt: ago(200 * DAY), revisionIds: ['rev-superseded-recent'],
      });
      await insertPublishedVersion(tx, {
        eventId: 'event-sup-recent', version: 2, publishedAt: ago(30 * DAY), revisionIds: ['rev-superseded-new-2'],
      });
      // An undecided proposal: its evidence is open work until a decision exists.
      await tx.query(
        `INSERT INTO waspada.extraction_results (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
         VALUES ('live', 'candidate-undecided', 'trace-retention', 'rev-undecided-proposal', 'group_specific_critical_notices', $1::jsonb)`,
        [FICTION],
      );
      await tx.query(
        `INSERT INTO waspada.grounding_contexts (dataset_kind, context_id, trace_id, candidate_id, retrieval_version,
           index_version, sufficient, record_json)
         VALUES ('live', 'context-undecided', 'trace-retention', 'candidate-undecided', 'retention-test-v1', 'retention-test-index', true, $1::jsonb)`,
        [FICTION],
      );
      await tx.query(
        `INSERT INTO waspada.event_proposals (dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id,
           base_event_version, proposed_at, record_json)
         VALUES ('live', 'proposal-undecided', 'trace-retention', 'candidate-undecided', 'context-undecided', NULL, NULL, $1, $2::jsonb)`,
        [ago(200 * DAY), FICTION],
      );
      await tx.query(
        `INSERT INTO waspada.proposal_claims (dataset_kind, proposal_id, claim_id, support_assessment, evidence_label, claim_text, record_json)
         VALUES ('live', 'proposal-undecided', 'claim-undecided', 'uncertain', 'attributed_report', 'Klaim belum diputuskan.', $1::jsonb)`,
        [FICTION],
      );
      const undecidedRef = await insertEvidence(tx, 'rev-undecided-proposal');
      await tx.query(
        `INSERT INTO waspada.proposal_claim_evidence (dataset_kind, proposal_id, claim_id, evidence_kind, evidence_ref_id)
         VALUES ('live', 'proposal-undecided', 'claim-undecided', 'support', $1)`,
        [undecidedRef],
      );
    });

    // Public attribution of the current revision: an approved review, as the public view reads it.
    await database.executor.query(
      `INSERT INTO waspada.public_attribution_review_decisions (review_decision_id, dataset_kind, evidence_ref_id,
         report_revision_id, permitted_text_hash, span_start, span_end, offset_unit, relation, review_version,
         decision_status, rights_basis_ref, public_display_name, source_url, source_published_at, source_observed_at,
         reviewer_id, decision_reason, reviewed_at)
       SELECT 'review-retention-current', 'live', er.evidence_ref_id, er.report_revision_id, er.permitted_text_hash,
              er.span_start, er.span_end, er.offset_unit, er.relation, 1, 'approved',
              'fictional rights basis for a database test', 'Sumber Fiksi Uji', 'https://retention.invalid/berita',
              NULL, NULL, 'moderator-fixture', 'fictional test decision', $1
         FROM waspada.evidence_references AS er
        WHERE er.dataset_kind = 'live' AND er.report_revision_id = 'rev-published-current'`,
      [ago(19 * DAY)],
    );

    // Open work: a pending AI job still needs its revision's text.
    await database.executor.query(
      `INSERT INTO waspada.ai_jobs (job_id, dataset_kind, report_revision_id, status, attempt_count, max_attempts,
         available_at, trace_id, created_at, updated_at)
       VALUES ('job-retention-open', 'live', 'rev-open-job', 'pending', 0, 5, $1, 'trace-retention', $1, $1)`,
      [ago(200 * DAY)],
    );

    // Audit: one row past 24 months, one at 23 months, one recent.
    const audit = (id: string, occurredAt: string) => database.executor.query(
      `INSERT INTO waspada.audit_records (dataset_kind, audit_id, trace_id, occurred_at, actor_id, action, entity_type,
         entity_id, reason, details)
       VALUES ('live', $1, 'trace-retention', $2, 'operator-fixture', 'retention_test', 'fixture', $1,
         'fictional test row', '{}'::jsonb)`,
      [id, occurredAt],
    );
    await audit('audit-old-25-months', ago(760 * DAY));
    await audit('audit-young-23-months', ago(700 * DAY));
    await audit('audit-recent', ago(30 * DAY));

    // Account admin audit: one provisioned account, with one row past 24 months and one recent row.
    const accounts = createAccountStore(database.executor, 'live');
    const user = await accounts.createPasswordAccount({
      datasetMode: 'live',
      username: 'retensi.uji',
      passwordHash: `pbkdf2-sha256$100000$${'A'.repeat(22)}$${'B'.repeat(43)}`,
      displayName: 'Retensi Uji',
      role: 'user',
      now: ago(800 * DAY),
    });
    userId = user.id;
    const adminAudit = (occurredAt: string) => database.executor.query(
      `INSERT INTO waspada.account_admin_audit (dataset_mode, actor_kind, actor_account_id, target_account_id, action,
         reason, actor_role_at_action, target_role_before, target_role_after, target_active_before, target_active_after,
         expected_version, target_version_after, occurred_at)
       VALUES ('live', 'operator', NULL, $1, 'account_provisioned', 'fictional retention test', NULL, NULL, 'user',
         NULL, true, NULL, 1, $2)`,
      [userId, occurredAt],
    );
    await adminAudit(ago(800 * DAY));
    await adminAudit(ago(30 * DAY));

    // Triage caches: one past its expiry, one still within its seven days.
    const triage = (hash: string, expiresAt: string) => database.executor.query(
      `INSERT INTO waspada.news_triage_decisions (dataset_kind, item_identity_hash, source_id, trace_id, disposition,
         jakarta_scope, actionability, confidence, reason_codes, evaluated_at, expires_at)
       VALUES ('live', $1, 'source-retention', 'trace-retention', 'drop', 'unknown', 'none', 'low', ARRAY['fixture'], $2, $3)`,
      [hash, ago(8 * DAY), expiresAt],
    );
    await triage(sha('item-expired'), ago(31 * DAY));
    await triage(sha('item-expired-recently'), ago(1 * DAY));
    await triage(sha('item-fresh'), new Date(Date.parse(NOW) + 6 * DAY).toISOString());

    // Public history: every published version is approved for the public history, as the reader requires.
    for (const [eventId, version] of [
      ['event-pub-1', 1], ['event-sup-old', 1], ['event-sup-old', 2], ['event-sup-recent', 1], ['event-sup-recent', 2],
    ] as const) {
      await database.executor.query(
        `INSERT INTO waspada.public_event_history_review_decisions (dataset_kind, event_id, event_version, publication_status,
           review_status, change_type, summary, reviewer_id, reviewed_at)
         VALUES ('live', $1, $2, 'published', 'approved', 'published', 'Ringkasan tinjauan fiksi.', 'moderator-fixture', $3)`,
        [eventId, version, ago(5 * DAY)],
      );
    }

    for (const table of PROTECTED_TABLES) protectedBefore.set(table, await countRows(table));
    firstPurge = await purgeAs(NOW);
  });

  after(async () => {
    await database?.close();
  });

  it('NFR-07: expired text is purged at the 365-day cap and at 90 days, and fresh, current, open and retracted text is kept', async () => {
    assert.equal(firstPurge.source_text_nulled, '4', 'two 365-day and two 90-day expiries');
    const rows = await database.executor.query<{ report_revision_id: string; permitted_text: string | null }>(
      'SELECT report_revision_id, permitted_text FROM waspada.report_revisions',
    );
    const purged = rows.rows.filter((row) => row.permitted_text === null).map((row) => row.report_revision_id);
    const kept = rows.rows.filter((row) => row.permitted_text !== null).map((row) => row.report_revision_id);
    assert.deepEqual([...purged].sort(), ['rev-expired-365', 'rev-expired-90', 'rev-published-cap', 'rev-superseded-old']);
    assert.deepEqual([...kept].sort(), [
      'rev-fresh', 'rev-open-job', 'rev-published-current', 'rev-retracted', 'rev-superseded-new',
      'rev-superseded-new-2', 'rev-superseded-recent', 'rev-undecided-proposal', 'rev-vector-current',
    ]);
  });

  it('NFR-07: text cited only by a superseded version is kept for 90 days after that version stops being current, then purged', async () => {
    const text = await database.executor.query<{ report_revision_id: string; text_removed: boolean }>(
      `SELECT report_revision_id, permitted_text IS NULL AS text_removed FROM waspada.report_revisions
        WHERE report_revision_id IN ('rev-superseded-old', 'rev-superseded-recent')`,
    );
    const byId = new Map(text.rows.map((row) => [row.report_revision_id, row.text_removed]));
    assert.equal(byId.get('rev-superseded-old'), true, 'superseded 120 days ago: purged');
    assert.equal(byId.get('rev-superseded-recent'), false, 'superseded 30 days ago: kept');
  });

  it('NFR-07: a purged revision keeps its row, hash, retrieval time, status and every key that points at it', async () => {
    const row = await database.executor.query<{ permitted_text_hash: string; retrieved_at: string; revision_status: string; refs: string; citations: string }>(
      `SELECT rr.permitted_text_hash, rr.retrieved_at::text AS retrieved_at, rr.revision_status,
              (SELECT count(*)::text FROM waspada.evidence_references er WHERE er.report_revision_id = rr.report_revision_id) AS refs,
              (SELECT count(*)::text FROM waspada.event_claim_evidence ece
                 JOIN waspada.evidence_references er ON er.evidence_ref_id = ece.evidence_ref_id
                WHERE er.report_revision_id = rr.report_revision_id) AS citations
         FROM waspada.report_revisions rr WHERE rr.report_revision_id = 'rev-published-cap'`,
    );
    assert.equal(row.rows[0]?.permitted_text_hash, sha(textOf('rev-published-cap')), 'the hash of the removed text is kept');
    assert.equal(row.rows[0]?.revision_status, 'unreviewed');
    assert.equal(row.rows[0]?.refs, '1', 'the evidence reference that cites it still exists');
    assert.equal(row.rows[0]?.citations, '1', 'the published claim that cites it still points at the reference');
    assert.match(row.rows[0]?.retrieved_at ?? '', /^2025-/u, 'the retrieval time is kept');
  });

  it('NFR-07: embeddings are purged with their source text or their retraction, and the embedding of current text is kept however old it is', async () => {
    assert.equal(firstPurge.vectors_removed, '2', 'the vectors of the expired and retracted revisions');
    const runs = await database.executor.query<{ embedding_run_id: string; status: string }>(
      'SELECT embedding_run_id, status FROM waspada.embedding_runs',
    );
    assert.deepEqual([...runs.rows].sort((a, b) => a.embedding_run_id.localeCompare(b.embedding_run_id)).map((row) => [row.embedding_run_id, row.status]), [
      ['run-rev-expired-365', 'invalidated'],
      ['run-rev-retracted', 'invalidated'],
      ['run-rev-vector-current', 'available'],
    ]);
    const vectors = await database.executor.query<{ embedding_run_id: string }>(
      'SELECT embedding_run_id FROM waspada.embedding_vectors',
    );
    assert.deepEqual(vectors.rows, [{ embedding_run_id: 'run-rev-vector-current' }]);
    const chunks = await database.executor.query<{ chunk_id: string; status: string }>(
      'SELECT chunk_id, status FROM waspada.evidence_chunks',
    );
    const chunkStatus = new Map(chunks.rows.map((row) => [row.chunk_id, row.status]));
    assert.equal(chunkStatus.get('chunk-rev-expired-365'), 'invalidated');
    assert.equal(chunkStatus.get('chunk-rev-retracted'), 'invalidated');
    assert.equal(chunkStatus.get('chunk-rev-vector-current'), 'active');
  });

  it('NFR-07: audit rows older than 24 months are purged, and younger audit rows are kept', async () => {
    assert.equal(firstPurge.audit_records_removed, '1');
    assert.equal(firstPurge.account_admin_audit_removed, '1');
    const audit = await database.executor.query<{ audit_id: string }>('SELECT audit_id FROM waspada.audit_records');
    assert.deepEqual(audit.rows.map((row) => row.audit_id).sort(), ['audit-recent', 'audit-young-23-months']);
    const admin = await database.executor.query<{ occurred_at: string }>(
      'SELECT occurred_at::text AS occurred_at FROM waspada.account_admin_audit',
    );
    assert.equal(admin.rows.length, 1, 'the admin row past 24 months is gone and the recent one stays');
    const account = await database.executor.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM waspada.accounts WHERE account_id = $1', [userId],
    );
    assert.equal(account.rows[0]?.n, '1', 'the provisioned account itself is never removed by the purge');
  });

  it('NFR-07: triage decisions expired over 30 days ago are purged; recently expired and unexpired decisions are kept', async () => {
    assert.equal(firstPurge.triage_decisions_removed, '1');
    const rows = await database.executor.query<{ item_identity_hash: string }>(
      'SELECT item_identity_hash FROM waspada.news_triage_decisions ORDER BY item_identity_hash',
    );
    assert.deepEqual(
      rows.rows.map((row) => row.item_identity_hash).sort(),
      [sha('item-expired-recently'), sha('item-fresh')].sort(),
    );
  });

  it('NFR-07: published public events still read correctly after the purge', async () => {
    const history = await database.executor.query<{ event_id: string; version: number }>(
      `SELECT event_id, version FROM waspada.public_event_history_versions
        WHERE event_id IN ('event-pub-1', 'event-sup-old', 'event-sup-recent')`,
    );
    const versions = history.rows.map((row) => `${row.event_id}@${row.version}`).sort();
    assert.deepEqual(versions, [
      'event-pub-1@1', 'event-sup-old@1', 'event-sup-old@2', 'event-sup-recent@1', 'event-sup-recent@2',
    ], 'the public history still lists every published version');
    const current = await database.executor.query<{ event_id: string; version: number }>(
      `SELECT event_id, version FROM waspada.public_event_versions
        WHERE event_id IN ('event-pub-1', 'event-sup-old', 'event-sup-recent')`,
    );
    assert.deepEqual(current.rows.map((row) => `${row.event_id}@${row.version}`).sort(), [
      'event-pub-1@1', 'event-sup-old@2', 'event-sup-recent@2',
    ], 'the current public read still shows the latest version of each event');
    const attribution = await database.executor.query<{ display_name: string; url: string; retrieved_at: string }>(
      `SELECT display_name, url, retrieved_at::text AS retrieved_at FROM waspada.public_source_attributions
        WHERE report_revision_id = 'rev-published-current'`,
    );
    assert.equal(attribution.rows.length, 1, 'the attribution of the current revision still resolves');
    assert.equal(attribution.rows[0]?.display_name, 'Sumber Fiksi Uji');
    assert.equal(attribution.rows[0]?.url, 'https://retention.invalid/berita');
    assert.equal((attribution.rows[0]?.retrieved_at ?? '').slice(0, 10), ago(200 * DAY).slice(0, 10), 'the acquisition day the public page shows is kept');
  });

  it('NFR-07: the purge deletes no published version, claim, evidence reference, decision, revision row or source row', async () => {
    for (const table of PROTECTED_TABLES) {
      assert.equal(await countRows(table), protectedBefore.get(table), `${table} keeps every row`);
    }
  });

  it('NFR-07: the purge is idempotent: a second run on the same clock removes nothing', async () => {
    const again = await purgeAs(NOW);
    assert.deepEqual(again, {
      source_text_nulled: '0',
      vectors_removed: '0',
      audit_records_removed: '0',
      account_admin_audit_removed: '0',
      triage_decisions_removed: '0',
    });
    assert.deepEqual(await purgeAs(NOW), again);
  });

  it('NFR-07: the append-only guards still refuse every other change to revisions and audit rows, for the owner role', async () => {
    await assert.rejects(
      database.executor.query(`UPDATE waspada.report_revisions SET record_json = '{}'::jsonb WHERE report_revision_id = 'rev-fresh'`),
      /is append-only/u,
    );
    await assert.rejects(
      database.executor.query(`UPDATE waspada.report_revisions SET permitted_text = 'texto kembali' WHERE report_revision_id = 'rev-expired-365'`),
      /is append-only/u,
      'text is never restored once it is removed',
    );
    await assert.rejects(
      database.executor.query(`DELETE FROM waspada.report_revisions WHERE report_revision_id = 'rev-fresh'`),
      /is append-only/u,
    );
    await assert.rejects(
      database.executor.query(`DELETE FROM waspada.audit_records WHERE audit_id = 'audit-recent'`),
      /is append-only/u,
      'a row younger than 24 months is never deleted',
    );
    await assert.rejects(
      database.executor.query(`UPDATE waspada.audit_records SET reason = 'diubah' WHERE audit_id = 'audit-young-23-months'`),
      /is append-only/u,
    );
    await assert.rejects(
      database.executor.query('DELETE FROM waspada.account_admin_audit WHERE occurred_at > $1', [ago(60 * DAY)]),
      /account audit rows are append-only/u,
    );
  });

  it('NFR-07: the purger role can run the purge and write nothing else, and a layer role cannot run it', async () => {
    await database.executor.execute(`SET ROLE ${PURGER}`);
    try {
      await assert.rejects(
        database.executor.query('DELETE FROM waspada.event_versions WHERE event_id = $1', ['event-pub-1']),
        /permission denied/u,
        'the purger cannot delete a published version',
      );
      await assert.rejects(
        database.executor.query('DELETE FROM waspada.event_claims WHERE event_id = $1', ['event-pub-1']),
        /permission denied/u,
      );
      await assert.rejects(
        database.executor.query(`UPDATE waspada.report_revisions SET record_json = '{}'::jsonb`),
        /permission denied/u,
      );
      await assert.rejects(
        database.executor.query('DELETE FROM waspada.report_revisions'),
        /permission denied/u,
      );
      await assert.rejects(
        database.executor.query(`UPDATE waspada.audit_records SET reason = 'diubah'`),
        /permission denied/u,
      );
      await assert.rejects(
        database.executor.query(`DELETE FROM waspada.audit_records WHERE audit_id = 'audit-recent'`),
        /is append-only/u,
        'even with delete privilege, the guard keeps the young row',
      );
    } finally {
      await database.executor.execute('RESET ROLE');
    }
    const privileges = await database.executor.query<{ purger_can_execute: boolean; layer_can_execute: boolean; purger_can_delete_events: boolean }>(
      `SELECT has_function_privilege('${PURGER}', 'waspada.purge_expired_retention(timestamptz)', 'EXECUTE') AS purger_can_execute,
              has_function_privilege('waspada_l1_pipeline', 'waspada.purge_expired_retention(timestamptz)', 'EXECUTE') AS layer_can_execute,
              has_table_privilege('${PURGER}', 'waspada.event_versions', 'DELETE') AS purger_can_delete_events`,
    );
    assert.deepEqual(privileges.rows, [{ purger_can_execute: true, layer_can_execute: false, purger_can_delete_events: false }]);
  });
});
