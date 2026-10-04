import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  createReportRevisionImpactTargetReader,
  ReportRevisionImpactReaderError,
  type ReportRevisionImpactDatasetKind,
} from '../src/report-revision-impact-reader.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import type { SqlExecutor } from '../src/sql.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const NOW = '2026-10-02T10:00:00Z';
const READER_ROLE = 'waspada_l4_report_revision_impact_reader';
const PRIVATE_SOURCE_TEXT = 'Authored private source fixture; no actual report or event was observed.';
const PRIVATE_CLAIM_TEXT = 'Authored private claim fixture; never return this text.';

type EvidenceKind = 'support' | 'contradiction' | 'context';
interface ClaimFixture {
  readonly id: string;
  readonly links: readonly { readonly key: string; readonly kind: EvidenceKind }[];
}
interface ImpactFixture {
  readonly id: string;
  readonly version: number;
  readonly claims: readonly string[];
}
interface EventVersionFixture {
  readonly version: number;
  readonly status?: 'published' | 'withdrawn';
  readonly claims?: readonly ClaimFixture[];
  readonly impacts?: readonly ImpactFixture[];
}

let database!: TestDatabase;
describe('LIFE-01 report-revision impact reader', () => {
  let reader: ReturnType<typeof createReportRevisionImpactTargetReader>;

  before(async () => {
    database = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(database.executor, migrations);
    await seedDataset('synthetic');
    await seedDataset('historical');
    reader = createReportRevisionImpactTargetReader(database.executor);
  });

  after(async () => database?.close());

  it('maps only exact support lineage to current published event and impact targets', async () => {
    const page = await reader.read({
      datasetKind: 'synthetic',
      reportRevisionId: 'revision-shared',
      limit: 100,
    });
    assert.deepEqual(page.targets.map(targetKey), [
      'event-a:event_claim_set',
      'event-a:impact:impact-linked:1',
      'event-a:impact:impact-versioned:1',
      'event-b:event_claim_set',
      'event-c:event_claim_set',
    ]);
    assert.equal(page.nextCursor, null);
    assert.equal(page.targets.every(({ datasetKind }) => datasetKind === 'synthetic'), true);
    assert.equal(page.targets.some(({ eventId }) => eventId === 'event-old-only'), false,
      'a latest published version without this revision in support lineage is excluded');
    assert.equal(page.targets.some(({ eventId }) => eventId === 'event-withdrawn'), false,
      'the latest withdrawn version hides an earlier matching published version');
    for (const impactId of [
      'impact-unsupported', 'impact-contradiction', 'impact-context',
    ]) {
      assert.equal(page.targets.some(({ target }) =>
        target.kind === 'impact' && target.impactId === impactId), false,
      'impact targets require a direct claim-support link to a claim supported by this revision');
    }
    assert.equal(page.targets.some(({ target }) =>
      target.kind === 'impact' && target.impactId === 'impact-versioned' && target.impactVersion !== 1), false,
    'only the exact impact version referenced by the current event version is returned');
    const serialized = JSON.stringify(page);
    assert.doesNotMatch(serialized, /a-current-supported|PRIVATE_SOURCE_TEXT|Authored private|permittedText|reportRevisionId|evidenceRefId/i);
    for (const target of page.targets) {
      assert.deepEqual(Object.keys(target).sort(), ['datasetKind', 'eventId', 'eventVersion', 'target']);
      assert.deepEqual(Object.keys(target.target).sort(),
        target.target.kind === 'impact'
          ? ['impactId', 'impactVersion', 'kind']
          : ['kind']);
    }
  });

  it('requires an explicit dataset and keeps overlapping identifiers isolated', async () => {
    const synthetic = await reader.read({
      datasetKind: 'synthetic', reportRevisionId: 'revision-shared', limit: 100,
    });
    const historical = await reader.read({
      datasetKind: 'historical', reportRevisionId: 'revision-shared', limit: 100,
    });
    assert.equal(synthetic.targets.some(({ datasetKind }) => datasetKind === 'historical'), false);
    assert.deepEqual(historical.targets.map(targetKey), synthetic.targets.map(targetKey));
    assert.equal(historical.targets.every(({ datasetKind }) => datasetKind === 'historical'), true);
    assert.equal(synthetic.targets.every(({ datasetKind }) => datasetKind === 'synthetic'), true);
    await expectReaderError(reader.read({ reportRevisionId: 'revision-shared', limit: 10 }), 'INVALID_REQUEST');
  });

  it('uses a bounded stable keyset cursor without duplicates', async () => {
    const request = {
      datasetKind: 'synthetic' as const,
      reportRevisionId: 'revision-shared',
      limit: 2,
    };
    const first = await reader.read(request);
    assert.deepEqual(first.targets.map(targetKey), [
      'event-a:event_claim_set',
      'event-a:impact:impact-linked:1',
    ]);
    assert.deepEqual(first.nextCursor, {
      eventId: 'event-a',
      eventVersion: 2,
      target: { kind: 'impact', impactId: 'impact-linked', impactVersion: 1 },
    });
    const second = await reader.read({ ...request, cursor: first.nextCursor });
    const third = await reader.read({ ...request, cursor: second.nextCursor });
    assert.deepEqual(second.targets.map(targetKey), [
      'event-a:impact:impact-versioned:1',
      'event-b:event_claim_set',
    ]);
    assert.deepEqual(third.targets.map(targetKey), ['event-c:event_claim_set']);
    assert.equal(third.nextCursor, null);
    const all = [...first.targets, ...second.targets, ...third.targets].map(targetKey);
    assert.equal(new Set(all).size, 5);
    assert.deepEqual(all, [
      'event-a:event_claim_set',
      'event-a:impact:impact-linked:1',
      'event-a:impact:impact-versioned:1',
      'event-b:event_claim_set',
      'event-c:event_claim_set',
    ]);
  });

  it('rejects unbounded, malformed, or extended request and cursor shapes', async () => {
    const valid = { datasetKind: 'synthetic', reportRevisionId: 'revision-shared', limit: 1 };
    for (const request of [
      { ...valid, limit: 0 },
      { ...valid, limit: 101 },
      { ...valid, datasetKind: 'unknown' },
      { ...valid, extra: 'ignored-fields-are-not-allowed' },
      { ...valid, cursor: { eventId: 'event-a', eventVersion: 2, target: { kind: 'event_claim_set', claimId: 'private' } } },
      { ...valid, cursor: { eventId: 'event-a', eventVersion: 0, target: { kind: 'event_claim_set' } } },
    ]) {
      await expectReaderError(reader.read(request), 'INVALID_REQUEST');
    }
  });

  it('redacts malformed rows and SQL diagnostics behind fixed reader errors', async () => {
    const request = {
      datasetKind: 'synthetic',
      reportRevisionId: 'revision-shared',
      limit: 10,
    };
    const malformedReader = createReportRevisionImpactTargetReader({
      query: async () => ({
        rows: [{
          dataset_kind: 'synthetic',
          event_id: 'event-a',
          event_version: 2,
          target_kind: 'impact',
          impact_id: null,
          impact_version: null,
        }],
      }),
    } as unknown as SqlExecutor);
    await assert.rejects(
      malformedReader.read(request),
      (error: unknown) => error instanceof ReportRevisionImpactReaderError
        && error.code === 'INVALID_RESULT'
        && error.message === 'The report-revision impact page could not be validated.',
    );

    const failingReader = createReportRevisionImpactTargetReader({
      query: async () => {
        throw new Error('private database diagnostic');
      },
    } as unknown as SqlExecutor);
    await assert.rejects(
      failingReader.read(request),
      (error: unknown) => error instanceof ReportRevisionImpactReaderError
        && error.code === 'READ_FAILED'
        && error.message === 'The report-revision impact page could not be read.',
    );
  });

  it('runs as a standalone read-only role and denies source text and every write class', async () => {
    const beforeState = await readSideEffectSnapshot();
    await database.executor.execute('SET ROLE ' + READER_ROLE);
    try {
      const active = await database.executor.query<{ current_user: string }>('SELECT current_user');
      assert.equal(active.rows[0]?.current_user, READER_ROLE);
      const page = await reader.read({
        datasetKind: 'synthetic', reportRevisionId: 'revision-shared', limit: 100,
      });
      assert.equal(page.targets.length, 5);
      await assert.rejects(
        database.executor.query('SELECT permitted_text FROM waspada.report_revisions'),
      );
      await assert.rejects(database.executor.query(
        "INSERT INTO waspada.evidence_references (dataset_kind, trace_id, report_revision_id, permitted_text_hash, span_start, span_end, offset_unit, relation) VALUES ('synthetic', 'trace-impact-synthetic', 'revision-shared', '0000000000000000000000000000000000000000000000000000000000000000', 0, 1, 'unicode_code_points', 'supports')",
      ));
      await assert.rejects(database.executor.query(
        "UPDATE waspada.evidence_references SET relation = 'context' WHERE dataset_kind = 'synthetic' AND report_revision_id = 'revision-shared'",
      ));
      await assert.rejects(database.executor.query(
        "DELETE FROM waspada.event_impact_refs WHERE dataset_kind = 'synthetic' AND event_id = 'event-a'",
      ));
      await assert.rejects(database.executor.execute('TRUNCATE waspada.event_versions'));
      await assert.rejects(database.executor.query(
        "INSERT INTO waspada.freshness_transitions (dataset_kind, event_id, event_version, target_kind, transition_sequence, previous_status, resulting_status, reason, evaluated_at, trace_id, idempotency_key, request_fingerprint) VALUES ('synthetic', 'event-a', 2, 'event_claim_set', 1, 'current', 'needs_update', 'review_deadline_missed', '2026-10-02T10:00:00Z', 'trace-impact-synthetic', 'reader-must-not-write', '0000000000000000000000000000000000000000000000000000000000000000')",
      ));
    } finally {
      await database.executor.execute('RESET ROLE');
    }
    assert.deepEqual(await readSideEffectSnapshot(), beforeState,
      'the query and denied mutations leave publication, history, freshness, and outbox state unchanged');
    await assertReaderAcl();
  });
});

async function seedDataset(datasetKind: 'synthetic' | 'historical'): Promise<void> {
  const suffix = datasetKind;
  const traceId = 'trace-impact-' + suffix;
  const sourceId = 'source-impact-' + suffix;
  const sharedText = PRIVATE_SOURCE_TEXT;
  const otherText = 'Authored unrelated source fixture.';
  const sharedHash = hash(sharedText);
  const otherHash = hash(otherText);
  const sharedContentHash = hash('shared source content ' + suffix);
  const otherContentHash = hash('other source content ' + suffix);
  const sharedRevision = 'revision-shared';
  const otherRevision = 'revision-other';

  await database.executor.query(
    "INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata) VALUES ($1, $2, $3, 'open', '{\"fixture\":\"synthetic-only\"}'::jsonb)",
    [traceId, datasetKind, NOW],
  );
  await database.executor.query(
    "INSERT INTO waspada.source_registry (source_id, trace_id, registry_version, display_name, source_kind, remit, access_method, approved_hosts, access_restrictions, reuse_basis, registry_status, approval_status, health_status, auto_acquisition_enabled, auto_publication_policy) VALUES ($1, $2, 1, 'Authored fixture source', 'other', ARRAY['test'], 'manual_fixture', ARRAY[]::text[], ARRAY['synthetic only'], ARRAY['authored fixture'], 'active', 'approved', 'unknown', false, 'never')",
    [sourceId, traceId],
  );
  for (const revision of [
    { id: sharedRevision, text: sharedText, textHash: sharedHash, contentHash: sharedContentHash, status: 'retracted' },
    { id: otherRevision, text: otherText, textHash: otherHash, contentHash: otherContentHash, status: 'eligible' },
  ]) {
    await database.executor.query(
      "INSERT INTO waspada.report_revisions (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'fixture-normalization-v1', $9, $10, '{\"fixture\":\"synthetic-only\"}'::jsonb)",
      [datasetKind, revision.id, traceId, sourceId, 'https://private.invalid/' + revision.id, revision.contentHash,
        revision.text, revision.textHash, NOW, revision.status],
    );
  }

  const evidence: Record<string, number> = {};
  let evidenceOffset = 0;
  for (const item of [
    { key: 'supportA', revision: sharedRevision, textHash: sharedHash, relation: 'supports' },
    { key: 'supportB', revision: sharedRevision, textHash: sharedHash, relation: 'supports' },
    { key: 'contradiction', revision: sharedRevision, textHash: sharedHash, relation: 'contradicts' },
    { key: 'context', revision: sharedRevision, textHash: sharedHash, relation: 'context' },
    { key: 'otherSupport', revision: otherRevision, textHash: otherHash, relation: 'supports' },
  ]) {
    const result = await database.executor.query<{ evidence_ref_id: string }>(
      "INSERT INTO waspada.evidence_references (dataset_kind, trace_id, report_revision_id, permitted_text_hash, span_start, span_end, offset_unit, relation) VALUES ($1, $2, $3, $4, $6, $7, 'unicode_code_points', $5) RETURNING evidence_ref_id::text AS evidence_ref_id",
      [datasetKind, traceId, item.revision, item.textHash, item.relation, evidenceOffset, evidenceOffset + 5],
    );
    evidenceOffset += 6;
    evidence[item.key] = Number(result.rows[0]!.evidence_ref_id);
  }

  const candidateId = 'candidate-impact-' + suffix;
  const contextId = 'context-impact-' + suffix;
  const proposalId = 'proposal-impact-' + suffix;
  await database.executor.query(
    "INSERT INTO waspada.extraction_results (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json) VALUES ($1, $2, $3, $4, NULL, '{\"fixture\":\"synthetic-only\"}'::jsonb)",
    [datasetKind, candidateId, traceId, sharedRevision],
  );
  await database.executor.query(
    "INSERT INTO waspada.grounding_contexts (dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version, sufficient, record_json) VALUES ($1, $2, $3, $4, 'fixture-retrieval-v1', 'fixture-index-v1', false, '{\"fixture\":\"synthetic-only\"}'::jsonb)",
    [datasetKind, contextId, traceId, candidateId],
  );
  await database.executor.query(
    "INSERT INTO waspada.event_proposals (dataset_kind, proposal_id, trace_id, candidate_id, context_id, proposed_at, record_json) VALUES ($1, $2, $3, $4, $5, $6, '{\"fixture\":\"synthetic-only\"}'::jsonb)",
    [datasetKind, proposalId, traceId, candidateId, contextId, NOW],
  );

  await seedEvent(datasetKind, proposalId, traceId, evidence, 'event-a', [
    { version: 1, claims: [{ id: 'a-old', links: [{ key: 'supportA', kind: 'support' }] }] },
    {
      version: 2,
      claims: [
        { id: 'a-current-supported', links: [
          { key: 'supportA', kind: 'support' }, { key: 'supportB', kind: 'support' },
        ] },
        { id: 'a-contradiction', links: [{ key: 'supportA', kind: 'contradiction' }] },
        { id: 'a-context', links: [{ key: 'context', kind: 'support' }] },
        { id: 'a-other-revision', links: [{ key: 'otherSupport', kind: 'support' }] },
      ],
      impacts: [
        { id: 'impact-linked', version: 1, claims: ['a-current-supported'] },
        { id: 'impact-versioned', version: 1, claims: ['a-current-supported'] },
        { id: 'impact-versioned', version: 2, claims: [] },
        { id: 'impact-unsupported', version: 1, claims: ['a-other-revision'] },
        { id: 'impact-contradiction', version: 1, claims: ['a-contradiction'] },
        { id: 'impact-context', version: 1, claims: ['a-context'] },
      ],
    },
  ]);
  await seedEvent(datasetKind, proposalId, traceId, evidence, 'event-b', [{
    version: 1,
    claims: [
      { id: 'b-supported-one', links: [{ key: 'supportA', kind: 'support' }] },
      { id: 'b-supported-two', links: [{ key: 'supportB', kind: 'support' }] },
    ],
  }]);
  await seedEvent(datasetKind, proposalId, traceId, evidence, 'event-c', [{
    version: 1,
    claims: [{ id: 'c-supported', links: [{ key: 'supportA', kind: 'support' }] }],
  }]);
  await seedEvent(datasetKind, proposalId, traceId, evidence, 'event-old-only', [
    { version: 1, claims: [{ id: 'old-matching', links: [{ key: 'supportA', kind: 'support' }] }] },
    { version: 2, claims: [{ id: 'old-current-other', links: [{ key: 'otherSupport', kind: 'support' }] }] },
  ]);
  await seedEvent(datasetKind, proposalId, traceId, evidence, 'event-withdrawn', [
    { version: 1, claims: [{ id: 'withdrawn-matching', links: [{ key: 'supportA', kind: 'support' }] }] },
    { version: 2, status: 'withdrawn' },
  ]);
}

async function seedEvent(
  datasetKind: ReportRevisionImpactDatasetKind,
  proposalId: string,
  traceId: string,
  evidence: Readonly<Record<string, number>>,
  eventId: string,
  versions: readonly EventVersionFixture[],
): Promise<void> {
  for (const fixture of versions) {
    const status = fixture.status ?? 'published';
    const claims = fixture.claims ?? [];
    const impacts = fixture.impacts ?? [];
    const decisionId = 'decision-' + datasetKind + '-' + eventId + '-' + fixture.version;
    const record = {
      schema_version: '2.0',
      trace_id: traceId,
      record_type: 'Event',
      dataset_kind: datasetKind,
      event_id: eventId,
      version: fixture.version,
      supersedes_version: fixture.version === 1 ? null : fixture.version - 1,
      title: 'Authored synthetic event title.',
      summary: 'Authored synthetic event summary.',
      category: 'transport_road_incidents',
      lifecycle: 'unknown',
      claims: status === 'published' ? claims.map(({ id }) => ({ claim_id: id, text: PRIVATE_CLAIM_TEXT })) : [],
      impact_refs: status === 'published' ? impacts.map(({ id, version }) => ({ impact_id: id, version })) : [],
      publication_status: status,
      withdrawal_reason: status === 'withdrawn' ? 'other' : null,
      publication_decision_id: decisionId,
      published_at: status === 'published' ? NOW : null,
      withdrawn_at: status === 'withdrawn' ? NOW : null,
    };
    await database.executor.transaction(async (transaction) => {
      await transaction.execute('SET CONSTRAINTS ALL DEFERRED');
      await transaction.query(
        "INSERT INTO waspada.publication_decisions (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id, event_version, decided_at, record_json) VALUES ($1, $2, $3, $4, 'fixture-policy-v1', $5, $6, $7, '{\"fixture\":\"synthetic-only\"}'::jsonb)",
        [datasetKind, decisionId, traceId, proposalId, eventId, fixture.version, NOW],
      );
      await transaction.query(
        "INSERT INTO waspada.event_versions (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary, category, lifecycle, publication_status, withdrawal_reason, publication_decision_id, published_at, withdrawn_at, record_json) VALUES ($1, $2, $3, $4, $5, $6, $7, 'transport_road_incidents', 'unknown', $8, $9, $10, $11, $12, $13::jsonb)",
        [datasetKind, eventId, fixture.version, traceId, fixture.version === 1 ? null : fixture.version - 1,
          'Authored synthetic event title.', 'Authored synthetic event summary.', status,
          status === 'withdrawn' ? 'other' : null, decisionId, status === 'published' ? NOW : null,
          status === 'withdrawn' ? NOW : null, JSON.stringify(record)],
      );
      if (status === 'published') {
        for (const claim of claims) {
          await transaction.query(
            "INSERT INTO waspada.event_claims (dataset_kind, event_id, event_version, claim_id, claim_text, evidence_label, record_json) VALUES ($1, $2, $3, $4, $5, 'issuer_notice', $6::jsonb)",
            [datasetKind, eventId, fixture.version, claim.id, PRIVATE_CLAIM_TEXT,
              JSON.stringify({ claim_id: claim.id, text: PRIVATE_CLAIM_TEXT })],
          );
          for (const link of claim.links) {
            await transaction.query(
              "INSERT INTO waspada.event_claim_evidence (dataset_kind, event_id, event_version, claim_id, evidence_kind, evidence_ref_id) VALUES ($1, $2, $3, $4, $5, $6)",
              [datasetKind, eventId, fixture.version, claim.id, link.kind, evidence[link.key]!],
            );
          }
        }
        for (const impact of impacts) {
          await transaction.query(
            "INSERT INTO waspada.impact_versions (dataset_kind, impact_id, version, trace_id, event_id, event_version, impact_type, lifecycle, published_at, record_json) VALUES ($1, $2, $3, $4, $5, $6, 'road_closure', 'unknown', $7, '{\"fixture\":\"private synthetic impact\"}'::jsonb)",
            [datasetKind, impact.id, impact.version, traceId, eventId, fixture.version, NOW],
          );
          await transaction.query(
            "INSERT INTO waspada.event_impact_refs (dataset_kind, event_id, event_version, impact_id, impact_version) VALUES ($1, $2, $3, $4, $5)",
            [datasetKind, eventId, fixture.version, impact.id, impact.version],
          );
          for (const claimId of impact.claims) {
            await transaction.query(
              "INSERT INTO waspada.impact_claim_support (dataset_kind, impact_id, impact_version, event_id, event_version, claim_id) VALUES ($1, $2, $3, $4, $5, $6)",
              [datasetKind, impact.id, impact.version, eventId, fixture.version, claimId],
            );
          }
        }
      }
    });
  }
}

async function assertReaderAcl(): Promise<void> {
  const role = await database.executor.query<{
    rolcanlogin: boolean;
    rolinherit: boolean;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
  }>(
    "SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1",
    [READER_ROLE],
  );
  assert.deepEqual(role.rows[0], {
    rolcanlogin: false,
    rolinherit: false,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
  });

  const allowed = new Set([
    'event_versions:dataset_kind',
    'event_versions:event_id',
    'event_versions:version',
    'event_versions:publication_status',
    'event_claim_evidence:dataset_kind',
    'event_claim_evidence:event_id',
    'event_claim_evidence:event_version',
    'event_claim_evidence:claim_id',
    'event_claim_evidence:evidence_kind',
    'event_claim_evidence:evidence_ref_id',
    'evidence_references:dataset_kind',
    'evidence_references:evidence_ref_id',
    'evidence_references:report_revision_id',
    'evidence_references:relation',
    'event_impact_refs:dataset_kind',
    'event_impact_refs:event_id',
    'event_impact_refs:event_version',
    'event_impact_refs:impact_id',
    'event_impact_refs:impact_version',
    'impact_claim_support:dataset_kind',
    'impact_claim_support:impact_id',
    'impact_claim_support:impact_version',
    'impact_claim_support:event_id',
    'impact_claim_support:event_version',
    'impact_claim_support:claim_id',
  ]);
  const selectColumns = await database.executor.query<{ column_key: string }>(
    "SELECT relation.relname || ':' || attribute.attname AS column_key FROM pg_class AS relation JOIN pg_namespace AS schema ON schema.oid = relation.relnamespace JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid WHERE schema.nspname = 'waspada' AND relation.relname = ANY(ARRAY['event_versions', 'event_claim_evidence', 'evidence_references', 'event_impact_refs', 'impact_claim_support']) AND attribute.attnum > 0 AND NOT attribute.attisdropped AND has_column_privilege($1, relation.oid, attribute.attnum, 'SELECT') ORDER BY column_key",
    [READER_ROLE],
  );
  assert.deepEqual(new Set(selectColumns.rows.map(({ column_key }) => column_key)), allowed);
  const tables = await database.executor.query<{ relname: string; can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean; can_truncate: boolean }>(
    "SELECT relation.relname, has_table_privilege($1, relation.oid, 'SELECT') AS can_select, has_table_privilege($1, relation.oid, 'INSERT') AS can_insert, has_table_privilege($1, relation.oid, 'UPDATE') AS can_update, has_table_privilege($1, relation.oid, 'DELETE') AS can_delete, has_table_privilege($1, relation.oid, 'TRUNCATE') AS can_truncate FROM pg_class AS relation JOIN pg_namespace AS schema ON schema.oid = relation.relnamespace WHERE schema.nspname = 'waspada' AND relation.relkind IN ('r', 'p')",
    [READER_ROLE],
  );
  assert.equal(tables.rows.every((row) =>
    !row.can_select && !row.can_insert && !row.can_update && !row.can_delete && !row.can_truncate), true,
  'the reader has column SELECT only, with no table-level access or mutation privilege');
  const columnWrites = await database.executor.query<{ can_insert: boolean; can_update: boolean; can_references: boolean }>(
    "SELECT has_column_privilege($1, relation.oid, attribute.attnum, 'INSERT') AS can_insert, has_column_privilege($1, relation.oid, attribute.attnum, 'UPDATE') AS can_update, has_column_privilege($1, relation.oid, attribute.attnum, 'REFERENCES') AS can_references FROM pg_class AS relation JOIN pg_namespace AS schema ON schema.oid = relation.relnamespace JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid WHERE schema.nspname = 'waspada' AND relation.relkind IN ('r', 'p') AND attribute.attnum > 0 AND NOT attribute.attisdropped",
    [READER_ROLE],
  );
  assert.equal(columnWrites.rows.every(({ can_insert, can_update, can_references }) =>
    !can_insert && !can_update && !can_references), true);
  const additional = await database.executor.query<{ raw_text: boolean; schema_create: boolean; sequence_usage: boolean; member_of: boolean; granted_to_member: boolean }>(
    "SELECT has_column_privilege($1, 'waspada.report_revisions', 'permitted_text', 'SELECT') AS raw_text, has_schema_privilege($1, 'waspada', 'CREATE') AS schema_create, COALESCE((SELECT bool_or(CASE WHEN sequence.relkind = 'S' THEN has_sequence_privilege($1, sequence.oid, 'USAGE') ELSE false END) FROM pg_class AS sequence JOIN pg_namespace AS schema ON schema.oid = sequence.relnamespace WHERE schema.nspname = 'waspada'), false) AS sequence_usage, EXISTS (SELECT 1 FROM pg_auth_members AS membership WHERE membership.member = (SELECT oid FROM pg_roles WHERE rolname = $1)) AS member_of, EXISTS (SELECT 1 FROM pg_auth_members AS membership WHERE membership.roleid = (SELECT oid FROM pg_roles WHERE rolname = $1)) AS granted_to_member",
    [READER_ROLE],
  );
  assert.deepEqual(additional.rows[0], {
    raw_text: false,
    schema_create: false,
    sequence_usage: false,
    member_of: false,
    granted_to_member: false,
  });
}

async function readSideEffectSnapshot(): Promise<Record<string, string>> {
  const snapshot = await database.executor.query<{
    event_versions: string;
    impact_versions: string;
    decisions: string;
    history_reviews: string;
    freshness: string;
    freshness_evidence: string;
    outbox: string;
  }>(
    "SELECT (SELECT count(*)::text FROM waspada.event_versions) AS event_versions, (SELECT count(*)::text FROM waspada.impact_versions) AS impact_versions, (SELECT count(*)::text FROM waspada.publication_decisions) AS decisions, (SELECT count(*)::text FROM waspada.public_event_history_review_decisions) AS history_reviews, (SELECT count(*)::text FROM waspada.freshness_transitions) AS freshness, (SELECT count(*)::text FROM waspada.freshness_transition_evidence) AS freshness_evidence, (SELECT count(*)::text FROM waspada.publication_outbox) AS outbox",
  );
  return snapshot.rows[0]!;
}

function targetKey(target: {
  readonly eventId: string;
  readonly target: { readonly kind: string; readonly impactId?: string; readonly impactVersion?: number };
}): string {
  return target.target.kind === 'impact'
    ? target.eventId + ':impact:' + target.target.impactId + ':' + target.target.impactVersion
    : target.eventId + ':event_claim_set';
}

async function expectReaderError(
  operation: Promise<unknown>,
  code: 'INVALID_REQUEST' | 'INVALID_RESULT' | 'READ_FAILED',
): Promise<void> {
  await assert.rejects(operation, (error: unknown) =>
    error instanceof ReportRevisionImpactReaderError && error.code === code);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
