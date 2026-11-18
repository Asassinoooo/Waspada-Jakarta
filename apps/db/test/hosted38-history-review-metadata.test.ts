import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

// HOSTED-38: migration 059 rewrites waspada.public_event_history_review_metadata
// history-first with LATERAL. These checks keep the rows, the grants and the
// security barrier identical to the migration 014 definition.

const TEST_TIME = '2026-11-19T10:00:00Z';

// The migration 014 definition, kept here only as the equivalence reference.
const LEGACY_REVIEW_METADATA_SQL = `
WITH latest_review AS (
  SELECT DISTINCT ON (decision.dataset_kind, decision.event_id, decision.event_version)
         decision.dataset_kind, decision.event_id, decision.event_version,
         decision.review_status, decision.change_type, decision.summary,
         decision.reviewer_id, decision.reviewed_at
  FROM waspada.public_event_history_review_decisions AS decision
  ORDER BY decision.dataset_kind, decision.event_id, decision.event_version,
           decision.review_id DESC
)
SELECT latest.dataset_kind, latest.event_id, latest.event_version,
       latest.review_status, latest.change_type, latest.summary,
       latest.reviewer_id, latest.reviewed_at
FROM latest_review AS latest
JOIN waspada.public_event_history_versions AS history
  ON history.dataset_kind = latest.dataset_kind
 AND history.event_id = latest.event_id
 AND history.version = latest.event_version
WHERE latest.review_status = 'approved'`;

interface Fixture {
  readonly datasetKind: 'live';
  readonly prefix: string;
  readonly traceId: string;
  readonly sourceId: string;
  readonly revisionId: string;
  readonly candidateId: string;
  readonly contextId: string;
}

interface SeedVersion {
  readonly version: number;
  readonly status?: 'published' | 'withdrawn';
}

interface ReviewInput {
  readonly eventId: string;
  readonly eventVersion: number;
  readonly status: 'approved' | 'held' | 'revoked';
  readonly changeType?: string | null;
  readonly summary?: string | null;
  readonly reviewerId?: string;
  readonly reviewedAt?: string;
}

interface MetadataRow {
  readonly event_id: string;
  readonly event_version: number;
  readonly review_status: string;
  readonly change_type: string;
  readonly summary: string;
  readonly reviewer_id: string;
  readonly reviewed_at: string;
}

let database: TestDatabase;
let fixture: Fixture;

describe('HOSTED-38 public history review metadata speed', () => {
  before(async () => {
    database = await createTestDatabase();
    await applyMigrations(database.executor, await readMigrations(new URL('../migrations/', import.meta.url)));
    await database.executor.query("INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')");
    fixture = await seedFixture('hosted38-history-live');

    // Version 1 is approved, then held: the newer held decision must hide it.
    // Version 2 has two approvals: only the newest one may appear, once.
    await seedEvent(fixture, 'event-latest-wins', [{ version: 1 }, { version: 2 }]);
    // The withdrawal makes version 1 non-public, so its approval must not appear.
    await seedEvent(fixture, 'event-hidden-version', [{ version: 1 }, { version: 2, status: 'withdrawn' }]);
    await seedEvent(fixture, 'event-single-approval', [{ version: 1 }]);
    await seedEvent(fixture, 'event-unreviewed', [{ version: 1 }]);

    await seedReview({ eventId: 'event-latest-wins', eventVersion: 1, status: 'approved', changeType: 'published', summary: 'Older approved first version.' });
    await seedReview({ eventId: 'event-latest-wins', eventVersion: 1, status: 'held' });
    await seedReview({ eventId: 'event-latest-wins', eventVersion: 2, status: 'approved', changeType: 'published', summary: 'Older approved second version.', reviewerId: 'moderator-first', reviewedAt: TEST_TIME });
    await seedReview({ eventId: 'event-latest-wins', eventVersion: 2, status: 'approved', changeType: 'corrected', summary: 'Newer approved second version.', reviewerId: 'moderator-second', reviewedAt: '2026-11-19T12:00:00Z' });
    await seedReview({ eventId: 'event-hidden-version', eventVersion: 1, status: 'approved', changeType: 'published', summary: 'Approval on a version hidden by a later withdrawal.' });
    await seedReview({ eventId: 'event-single-approval', eventVersion: 1, status: 'approved', changeType: 'published', summary: 'Single approval on a visible version.' });
  });

  after(async () => {
    await database?.close();
  });

  it('shows only the newest approved decision for each visible exact version, once', async () => {
    const rows = await database.executor.query<MetadataRow>(
      `SELECT event_id, event_version, review_status, change_type, summary, reviewer_id,
              to_char(reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS reviewed_at
       FROM waspada.public_event_history_review_metadata
       ORDER BY event_id, event_version`,
    );
    assert.deepEqual(rows.rows, [
      {
        event_id: 'event-latest-wins',
        event_version: 2,
        review_status: 'approved',
        change_type: 'corrected',
        summary: 'Newer approved second version.',
        reviewer_id: 'moderator-second',
        reviewed_at: '2026-11-19T12:00:00.000000Z',
      },
      {
        event_id: 'event-single-approval',
        event_version: 1,
        review_status: 'approved',
        change_type: 'published',
        summary: 'Single approval on a visible version.',
        reviewer_id: 'moderator-fixture',
        reviewed_at: '2026-11-19T10:00:00.000000Z',
      },
    ]);

    const history = await database.executor.query<{ event_id: string; version: number }>(
      "SELECT event_id, version FROM waspada.public_event_history_versions WHERE event_id IN ('event-hidden-version', 'event-unreviewed') ORDER BY event_id, version",
    );
    // Sanity: the withdrawn event's approved version 1 is not in public history at all,
    // while the unreviewed visible version is in public history but has no decision row.
    assert.deepEqual(history.rows, [{ event_id: 'event-unreviewed', version: 1 }]);
  });

  it('matches the migration 014 definition row for row on the seeded data', async () => {
    const counts = await database.executor.query<{ legacy_rows: string; view_rows: string; mismatches: string }>(
      `SELECT
         (SELECT count(*) FROM (${LEGACY_REVIEW_METADATA_SQL}) AS legacy)::text AS legacy_rows,
         (SELECT count(*) FROM waspada.public_event_history_review_metadata)::text AS view_rows,
         (SELECT count(*) FROM (
            ((${LEGACY_REVIEW_METADATA_SQL}) EXCEPT ALL (SELECT * FROM waspada.public_event_history_review_metadata))
            UNION ALL
            ((SELECT * FROM waspada.public_event_history_review_metadata) EXCEPT ALL (${LEGACY_REVIEW_METADATA_SQL}))
          ) AS difference)::text AS mismatches`,
    );
    assert.deepEqual(counts.rows, [{ legacy_rows: '2', view_rows: '2', mismatches: '0' }]);
  });

  it('keeps the public reader SELECT grant, no write grant and the security barrier', async () => {
    const grants = await database.executor.query<{
      can_read_view: boolean;
      can_write_view: boolean;
      reloptions: string[] | null;
    }>(
      `SELECT has_table_privilege('waspada_public_reader', 'waspada.public_event_history_review_metadata', 'SELECT') AS can_read_view,
              has_table_privilege('waspada_public_reader', 'waspada.public_event_history_review_metadata', 'INSERT') AS can_write_view,
              (SELECT reloptions FROM pg_class
               WHERE oid = 'waspada.public_event_history_review_metadata'::regclass) AS reloptions`,
    );
    assert.deepEqual(grants.rows, [{
      can_read_view: true,
      can_write_view: false,
      reloptions: ['security_barrier=true'],
    }]);

    const columns = await database.executor.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'waspada' AND table_name = 'public_event_history_review_metadata' ORDER BY ordinal_position",
    );
    assert.deepEqual(columns.rows.map(({ column_name }) => column_name), [
      'dataset_kind', 'event_id', 'event_version', 'review_status', 'change_type', 'summary', 'reviewer_id', 'reviewed_at',
    ]);
  });
});

async function seedFixture(prefix: string): Promise<Fixture> {
  const seeded: Fixture = {
    datasetKind: 'live',
    prefix,
    traceId: prefix + '-trace',
    sourceId: prefix + '-source',
    revisionId: prefix + '-revision',
    candidateId: prefix + '-candidate',
    contextId: prefix + '-context',
  };
  await database.executor.query(
    "INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata) VALUES ($1, $2, $3, 'succeeded', $4::jsonb)",
    [seeded.traceId, seeded.datasetKind, TEST_TIME, JSON.stringify({ fixture: 'authored-fiction-only' })],
  );
  await database.executor.query(
    "INSERT INTO waspada.source_registry (source_id, trace_id, registry_version, display_name, source_kind, remit, access_method, approved_hosts, access_restrictions, reuse_basis, registry_status, approval_status, health_status, auto_acquisition_enabled, auto_publication_policy) VALUES ($1, $2, 1, 'Fictional history metadata test source', 'other', ARRAY['test fixture'], 'manual_fixture', ARRAY[]::text[], ARRAY['fictional test only'], ARRAY['test only'], 'active', 'pending', 'unknown', false, 'never')",
    [seeded.sourceId, seeded.traceId],
  );
  await database.executor.query(
    "INSERT INTO waspada.report_revisions (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json) VALUES ($1, $2, $3, $4, $5, $6, 'Fictional text authored for a database test.', $7, 'history-metadata-test-v1', $8, 'unreviewed', $9::jsonb)",
    [seeded.datasetKind, seeded.revisionId, seeded.traceId, seeded.sourceId, 'https://' + prefix + '.invalid/fixture', 'b'.repeat(64), 'a'.repeat(64), TEST_TIME, JSON.stringify({ fixture: 'authored-fiction-only' })],
  );
  await database.executor.query(
    "INSERT INTO waspada.extraction_results (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json) VALUES ($1, $2, $3, $4, 'group_specific_critical_notices', $5::jsonb)",
    [seeded.datasetKind, seeded.candidateId, seeded.traceId, seeded.revisionId, JSON.stringify({ fixture: 'authored-fiction-only' })],
  );
  await database.executor.query(
    "INSERT INTO waspada.grounding_contexts (dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version, sufficient, record_json) VALUES ($1, $2, $3, $4, 'history-metadata-test-v1', 'history-metadata-index-v1', true, $5::jsonb)",
    [seeded.datasetKind, seeded.contextId, seeded.traceId, seeded.candidateId, JSON.stringify({ fixture: 'authored-fiction-only' })],
  );
  return seeded;
}

async function seedEvent(seeded: Fixture, eventId: string, versions: readonly SeedVersion[]): Promise<void> {
  for (const { version, status = 'published' } of versions) {
    const proposalId = seeded.prefix + '-proposal-' + eventId + '-v' + version;
    const decisionId = seeded.prefix + '-decision-' + eventId + '-v' + version;
    const record = eventRecord(seeded, eventId, version, status);
    const publishedAt = status === 'published' ? TEST_TIME : null;
    const withdrawnAt = status === 'withdrawn' ? TEST_TIME : null;
    const withdrawalReason = status === 'withdrawn' ? 'duplicate' : null;
    await database.executor.transaction(async (transaction) => {
      await transaction.execute('SET CONSTRAINTS ALL DEFERRED');
      await transaction.query(
        "INSERT INTO waspada.event_proposals (dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id, base_event_version, proposed_at, record_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)",
        [seeded.datasetKind, proposalId, seeded.traceId, seeded.candidateId, seeded.contextId, version === 1 ? null : eventId, version === 1 ? null : version - 1, TEST_TIME, JSON.stringify({ fixture: 'authored-fiction-only' })],
      );
      await transaction.query(
        "INSERT INTO waspada.publication_decisions (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id, event_version, decided_at, record_json) VALUES ($1, $2, $3, $4, 'history-metadata-test-policy-v1', $5, $6, $7, $8::jsonb)",
        [seeded.datasetKind, decisionId, seeded.traceId, proposalId, eventId, version, TEST_TIME, JSON.stringify({ fixture: 'authored-fiction-only' })],
      );
      await transaction.query(
        "INSERT INTO waspada.event_versions (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary, category, lifecycle, publication_status, withdrawal_reason, publication_decision_id, published_at, withdrawn_at, record_json) VALUES ($1, $2, $3, $4, $5, 'Fictional history metadata event', 'Authored fictional event for a bounded database test.', 'group_specific_critical_notices', 'unknown', $6, $7, $8, $9, $10, $11::jsonb)",
        [seeded.datasetKind, eventId, version, seeded.traceId, version === 1 ? null : version - 1, status, withdrawalReason, decisionId, publishedAt, withdrawnAt, JSON.stringify(record)],
      );
    });
  }
}

async function seedReview(input: ReviewInput): Promise<void> {
  await database.executor.query(
    'INSERT INTO waspada.public_event_history_review_decisions (dataset_kind, event_id, event_version, review_status, change_type, summary, reviewer_id, reviewed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    ['live', input.eventId, input.eventVersion, input.status, input.changeType ?? null, input.summary ?? null, input.reviewerId ?? 'moderator-fixture', input.reviewedAt ?? TEST_TIME],
  );
}

function eventRecord(seeded: Fixture, eventId: string, version: number, status: 'published' | 'withdrawn'): Record<string, unknown> {
  const published = status === 'published';
  return {
    schema_version: '2.0',
    trace_id: seeded.traceId,
    record_type: 'Event',
    dataset_kind: seeded.datasetKind,
    event_id: eventId,
    version,
    supersedes_version: version === 1 ? null : version - 1,
    title: 'Fictional history metadata event',
    summary: 'Authored fictional event for a bounded database test.',
    category: 'group_specific_critical_notices',
    tags: [],
    lifecycle: 'unknown',
    freshness: { status: 'current', evaluated_at: TEST_TIME, review_due_at: null, basis: 'unknown' },
    event_time: { start: null, end: null, precision: 'unknown' },
    validity: { valid_from: null, valid_until: null },
    scope: { place_ids: [], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [] },
    claims: published ? [{ claim_id: 'claim-' + eventId + '-v' + version }] : [],
    impact_refs: [],
    publication_status: status,
    withdrawal_reason: published ? null : 'duplicate',
    publication_decision_id: seeded.prefix + '-decision-' + eventId + '-v' + version,
    published_at: published ? TEST_TIME : null,
    withdrawn_at: published ? null : TEST_TIME,
  };
}
