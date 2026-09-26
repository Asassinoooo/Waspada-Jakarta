import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import {
  createPublicProjectionLookupRepository,
  PUBLIC_PROJECTION_LOOKUP_LIMITS,
  PublicProjectionLookupError,
  type PublicScopeNameKey,
  type PublicSupportingEvidenceKey,
} from '../src/public-projection-lookups.js';
import type { SqlExecutor } from '../src/sql.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const fixtureTraceId = 'trace-public-lookups-test';
const sourceText = 'Authored synthetic statement for lookup repository tests.';
const sourceTextHash = sha256(sourceText);
const supportOne: PublicSupportingEvidenceKey = {
  reportRevisionId: 'revision-public-lookups-one',
  permittedTextHash: sourceTextHash,
  spanStart: 0,
  spanEnd: 10,
  offsetUnit: 'unicode_code_points',
  relation: 'supports',
};
const supportTwo: PublicSupportingEvidenceKey = {
  reportRevisionId: 'revision-public-lookups-one',
  permittedTextHash: sourceTextHash,
  spanStart: 10,
  spanEnd: 20,
  offsetUnit: 'unicode_code_points',
  relation: 'supports',
};
const supportThree: PublicSupportingEvidenceKey = {
  reportRevisionId: 'revision-public-lookups-one',
  permittedTextHash: sourceTextHash,
  spanStart: 20,
  spanEnd: 30,
  offsetUnit: 'unicode_code_points',
  relation: 'supports',
};
const scopeApproved: PublicScopeNameKey = { entityType: 'audience', entityId: 'audience-lookup-approved' };
const scopeHeld: PublicScopeNameKey = { entityType: 'place', entityId: 'place-lookup-held' };
const scopeWithdrawn: PublicScopeNameKey = { entityType: 'service', entityId: 'service-lookup-withdrawn' };

let database: TestDatabase;
let evidenceOneId: number;
let evidenceTwoId: number;
let evidenceThreeId: number;

describe('API-PUBLIC-LOOKUPS-CORE reviewed lookup persistence and read port', () => {
  before(async () => {
    database = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(database.executor, migrations);

    // Every `live` marker, source, URL, review, and timestamp below is authored
    // synthetic test data. It asserts no real source, publication, rights, or reviewer.
    await database.executor.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, metadata)
       VALUES ($1, 'live', '2026-09-26T02:00:00Z', $2::jsonb)`,
      [fixtureTraceId, JSON.stringify({ fixture: 'authored-synthetic-only', rights: 'not-asserted' })],
    );
    await database.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit,
          access_method, access_restrictions, reuse_basis, registry_status,
          approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
       VALUES ('source-public-lookups-test', $1, 1, 'Synthetic fixture only', 'other',
          ARRAY['authored test fixture'], 'manual_fixture',
          ARRAY['no real source material or permission is represented'],
          ARRAY['test-only marker; grants no rights'], 'active', 'pending', 'unknown', false, 'never')`,
      [fixtureTraceId],
    );
    await database.executor.query(
      `INSERT INTO waspada.report_revisions
         (dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
          content_hash, permitted_text, permitted_text_hash, normalization_version,
          published_at, observed_at, retrieved_at, revision_status, record_json)
       VALUES ('live', $2, $1, 'source-public-lookups-test',
          'https://synthetic.invalid/public-lookups-fixture', $3, $4, $3,
          'authored-fixture-v1', '2026-09-26T03:15:00+07:00',
          '2026-09-26T03:20:00+07:00', '2026-09-26T03:21:00+07:00', 'unreviewed', $5::jsonb)`,
      [fixtureTraceId, supportOne.reportRevisionId, sourceTextHash, sourceText,
        JSON.stringify({ fixture: 'authored-synthetic-only' })],
    );
    evidenceOneId = await insertEvidence(supportOne);
    evidenceTwoId = await insertEvidence(supportTwo);
    evidenceThreeId = await insertEvidence(supportThree);

    await insertScopeDecision({
      reviewDecisionId: 'scope-approved-v1', key: scopeApproved, version: 1, status: 'approved',
      displayName: 'Mahasiswa', locale: 'id-ID',
    });
    await insertScopeDecision({
      reviewDecisionId: 'scope-approved-v2', key: scopeApproved, version: 2, status: 'approved',
      displayName: 'Mahasiswa Jakarta', locale: 'id-ID',
    });
    await insertScopeDecision({
      reviewDecisionId: 'scope-held-v1', key: scopeHeld, version: 1, status: 'approved',
      displayName: 'Tempat Sebelumnya',
    });
    await insertScopeDecision({
      reviewDecisionId: 'scope-held-v2', key: scopeHeld, version: 2, status: 'held',
    });
    await insertScopeDecision({
      reviewDecisionId: 'scope-withdrawn-v1', key: scopeWithdrawn, version: 1, status: 'approved',
      displayName: 'Layanan Sebelumnya',
    });
    await insertScopeDecision({
      reviewDecisionId: 'scope-withdrawn-v2', key: scopeWithdrawn, version: 2, status: 'withdrawn',
    });
    await insertScopeDecision({
      reviewDecisionId: 'scope-locale-en-v1',
      key: { entityType: 'institution', entityId: 'institution-lookup-en-only' },
      version: 1,
      status: 'approved',
      displayName: 'Synthetic Institution',
      locale: 'en-US',
    });

    await insertAttributionDecision({
      reviewDecisionId: 'attribution-one-v1', evidenceRefId: evidenceOneId, key: supportOne,
      version: 1, status: 'approved', displayName: 'Synthetic Publisher', url: 'https://synthetic.invalid/old',
      publishedAt: '2026-09-26T03:15:00+07:00', observedAt: '2026-09-26T03:20:00+07:00',
    });
    await insertAttributionDecision({
      reviewDecisionId: 'attribution-one-v2', evidenceRefId: evidenceOneId, key: supportOne,
      version: 2, status: 'approved', displayName: 'Synthetic Publisher Updated',
      url: 'https://synthetic.invalid/current',
      publishedAt: '2026-09-26T03:15:00+07:00', observedAt: '2026-09-26T03:20:00+07:00',
    });
    await insertAttributionDecision({
      reviewDecisionId: 'attribution-two-v1', evidenceRefId: evidenceTwoId, key: supportTwo,
      version: 1, status: 'approved', displayName: 'Synthetic Held Publisher',
      url: 'https://synthetic.invalid/held', publishedAt: null, observedAt: null,
    });
    await insertAttributionDecision({
      reviewDecisionId: 'attribution-two-v2', evidenceRefId: evidenceTwoId, key: supportTwo,
      version: 2, status: 'held',
    });
    await insertAttributionDecision({
      reviewDecisionId: 'attribution-three-v1', evidenceRefId: evidenceThreeId, key: supportThree,
      version: 1, status: 'approved', displayName: 'Synthetic Revoked Publisher',
      url: 'https://synthetic.invalid/revoked', publishedAt: null, observedAt: null,
    });
    await insertAttributionDecision({
      reviewDecisionId: 'attribution-three-v2', evidenceRefId: evidenceThreeId, key: supportThree,
      version: 2, status: 'revoked',
    });
  });

  after(async () => {
    await database.close();
  });

  it('returns only the latest approved Indonesian scope names and exact current support attributions', async () => {
    const repository = createPublicProjectionLookupRepository(database.executor);
    const result = await repository.resolve({
      scopeKeys: [
        { entityType: 'institution', entityId: 'institution-lookup-en-only' },
        scopeWithdrawn,
        scopeHeld,
        scopeApproved,
      ],
      supportReferences: [supportThree, supportTwo, supportOne],
    });

    assert.deepEqual(result.scopeNames, [
      { entity_type: 'audience', id: scopeApproved.entityId, display_name: 'Mahasiswa Jakarta' },
    ]);
    assert.deepEqual(result.publicAttributions, [{
      dataset_kind: 'live',
      report_revision_id: supportOne.reportRevisionId,
      permitted_text_hash: sourceTextHash,
      span_start: 0,
      span_end: 10,
      offset_unit: 'unicode_code_points',
      relation: 'supports',
      public_use_approved: true,
      display_name: 'Synthetic Publisher Updated',
      url: 'https://synthetic.invalid/current',
      published_at: '2026-09-25T20:15:00.000000Z',
      observed_at: '2026-09-25T20:20:00.000000Z',
      excerpt_public_use_approved: false,
      excerpt: null,
    }]);
    assert.deepEqual(Object.keys(result.scopeNames[0] ?? {}).sort(), ['display_name', 'entity_type', 'id']);
    assert.deepEqual(Object.keys(result.publicAttributions[0] ?? {}).sort(), [
      'dataset_kind', 'display_name', 'excerpt', 'excerpt_public_use_approved', 'observed_at',
      'offset_unit', 'permitted_text_hash', 'public_use_approved', 'published_at',
      'relation', 'report_revision_id', 'span_end', 'span_start', 'url',
    ]);
    assert.equal('rights_basis_ref' in (result.publicAttributions[0] ?? {}), false);
    assert.equal('permitted_text' in (result.publicAttributions[0] ?? {}), false);
  });

  it('omits missing, held, revoked, and inexact keys and rejects duplicate requested keys', async () => {
    const repository = createPublicProjectionLookupRepository(database.executor);
    const inexact: PublicSupportingEvidenceKey = { ...supportOne, spanEnd: supportOne.spanEnd + 1 };
    const missing: PublicScopeNameKey = { entityType: 'place', entityId: 'place-lookup-missing' };
    const result = await repository.resolve({
      scopeKeys: [missing, scopeHeld, scopeWithdrawn],
      supportReferences: [inexact, supportTwo, supportThree],
    });
    assert.deepEqual(result, { scopeNames: [], publicAttributions: [] });

    await assert.rejects(
      repository.resolve({ scopeKeys: [scopeApproved, scopeApproved], supportReferences: [] }),
      (error: unknown) => error instanceof PublicProjectionLookupError && error.code === 'INVALID_QUERY',
    );
  });

  it('rejects malformed and over-limit query keys without echoing caller values or querying SQL', async () => {
    const statements: string[] = [];
    const recordingExecutor: SqlExecutor = {
      async query<Row extends object>(statement: string) {
        statements.push(statement);
        return { rows: [] as Row[] };
      },
      async execute() {},
    };
    const repository = createPublicProjectionLookupRepository(recordingExecutor);
    const secretMarker = 'private key value must not appear';

    await assert.rejects(
      repository.resolve({ scopeKeys: [{ entityType: 'place', entityId: secretMarker }], supportReferences: [] }),
      (error: unknown) => error instanceof PublicProjectionLookupError
        && error.code === 'INVALID_QUERY' && !error.message.includes(secretMarker),
    );
    const excessive = Array.from({ length: PUBLIC_PROJECTION_LOOKUP_LIMITS.scopeKeys + 1 }, (_, index) => ({
      entityType: 'place', entityId: `place-over-limit-${index}`,
    }));
    await assert.rejects(
      repository.resolve({ scopeKeys: excessive, supportReferences: [] }),
      (error: unknown) => error instanceof PublicProjectionLookupError
        && error.code === 'QUERY_LIMIT_EXCEEDED' && !error.message.includes('place-over-limit'),
    );
    await assert.rejects(
      repository.resolve({
        scopeKeys: [],
        supportReferences: [{ ...supportOne, relation: 'contradicts' }],
      }),
      (error: unknown) => error instanceof PublicProjectionLookupError && error.code === 'INVALID_QUERY',
    );
    assert.deepEqual(statements, []);
  });

  it('uses parameterized exact-key SQL and keeps deterministic result ordering', async () => {
    const statements: Array<{ statement: string; parameters: readonly unknown[] | undefined }> = [];
    const recordingExecutor: SqlExecutor = {
      async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
        statements.push({ statement, parameters });
        return database.executor.query<Row>(statement, parameters);
      },
      async execute(statement: string) {
        await database.executor.execute(statement);
      },
    };
    const repository = createPublicProjectionLookupRepository(recordingExecutor);
    const result = await repository.resolve({
      scopeKeys: [scopeApproved, { entityType: 'audience', entityId: 'audience-lookup-missing' }],
      supportReferences: [supportOne, supportTwo],
    });

    assert.deepEqual(result.scopeNames.map(({ id }) => id), [scopeApproved.entityId]);
    assert.deepEqual(result.publicAttributions.map(({ report_revision_id, span_start }) => [report_revision_id, span_start]), [
      [supportOne.reportRevisionId, 0],
    ]);
    assert.equal(statements.length, 2);
    for (const { statement, parameters } of statements) {
      assert.match(statement, /unnest\(\$1/u);
      assert.equal(statement.includes(scopeApproved.entityId), false);
      assert.equal(statement.includes(supportOne.reportRevisionId), false);
      assert.ok(parameters && parameters.length > 0);
    }
    const scopeParameters = statements.find(({ statement }) => statement.includes('public_scope_names'))?.parameters;
    assert.ok(scopeParameters?.some((value) => Array.isArray(value) && value.includes(scopeApproved.entityId)));
    const supportParameters = statements.find(({ statement }) => statement.includes('public_source_attributions'))?.parameters;
    assert.ok(supportParameters?.some((value) => Array.isArray(value) && value.includes(supportOne.reportRevisionId)));
  });

  it('enforces exact live supporting-reference linkage, immutable history, and unique versions', async () => {
    const duplicateScope = insertScopeDecision({
      reviewDecisionId: 'scope-approved-duplicate-v2', key: scopeApproved, version: 2,
      status: 'approved', displayName: 'Duplicate version',
    });
    await assert.rejects(duplicateScope, /unique constraint/i);

    const duplicateAttribution = insertAttributionDecision({
      reviewDecisionId: 'attribution-one-duplicate-v2', evidenceRefId: evidenceOneId, key: supportOne,
      version: 2, status: 'approved', displayName: 'Duplicate version',
      url: 'https://synthetic.invalid/duplicate', publishedAt: null, observedAt: null,
    });
    await assert.rejects(duplicateAttribution, /unique constraint/i);

    await assert.rejects(
      insertAttributionDecision({
        reviewDecisionId: 'attribution-one-mismatched-span', evidenceRefId: evidenceOneId,
        key: { ...supportOne, spanEnd: supportOne.spanEnd + 1 }, version: 4, status: 'approved',
        displayName: 'Mismatched fixture', url: 'https://synthetic.invalid/mismatch',
        publishedAt: null, observedAt: null,
      }),
      /foreign key constraint/i,
    );
    await assert.rejects(
      insertAttributionDecision({
        reviewDecisionId: 'attribution-one-contradiction', evidenceRefId: evidenceOneId,
        key: { ...supportOne, relation: 'contradicts' as 'supports' }, version: 4, status: 'approved',
        displayName: 'Wrong relation fixture', url: 'https://synthetic.invalid/wrong-relation',
        publishedAt: null, observedAt: null,
      }),
      /check constraint/i,
    );

    await assert.rejects(
      database.executor.query(
        `UPDATE waspada.scope_name_review_decisions
         SET display_name = 'Changed' WHERE review_decision_id = 'scope-approved-v1'`,
      ),
      /append-only/i,
    );
    await assert.rejects(
      database.executor.query(
        `DELETE FROM waspada.public_attribution_review_decisions
         WHERE review_decision_id = 'attribution-one-v1'`,
      ),
      /append-only/i,
    );
    await assert.rejects(
      database.executor.execute('TRUNCATE waspada.scope_name_review_decisions'),
      /append-only/i,
    );

    const history = await database.executor.query<{ review_version: number; decision_status: string }>(
      `SELECT review_version, decision_status
       FROM waspada.public_attribution_review_decisions
       WHERE evidence_ref_id = $1 ORDER BY review_version`,
      [evidenceOneId],
    );
    assert.deepEqual(history.rows, [
      { review_version: 1, decision_status: 'approved' },
      { review_version: 2, decision_status: 'approved' },
    ]);
  });

  it('grants the reader the closed views only and denies approval/source reads and mutations', async () => {
    const viewColumns = await database.executor.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'waspada'
         AND table_name IN ('public_scope_names', 'public_source_attributions')
       ORDER BY table_name, ordinal_position`,
    );
    assert.deepEqual(viewColumns.rows, [
      { table_name: 'public_scope_names', column_name: 'entity_type' },
      { table_name: 'public_scope_names', column_name: 'id' },
      { table_name: 'public_scope_names', column_name: 'display_name' },
      { table_name: 'public_source_attributions', column_name: 'dataset_kind' },
      { table_name: 'public_source_attributions', column_name: 'report_revision_id' },
      { table_name: 'public_source_attributions', column_name: 'permitted_text_hash' },
      { table_name: 'public_source_attributions', column_name: 'span_start' },
      { table_name: 'public_source_attributions', column_name: 'span_end' },
      { table_name: 'public_source_attributions', column_name: 'offset_unit' },
      { table_name: 'public_source_attributions', column_name: 'relation' },
      { table_name: 'public_source_attributions', column_name: 'public_use_approved' },
      { table_name: 'public_source_attributions', column_name: 'display_name' },
      { table_name: 'public_source_attributions', column_name: 'url' },
      { table_name: 'public_source_attributions', column_name: 'published_at' },
      { table_name: 'public_source_attributions', column_name: 'observed_at' },
      { table_name: 'public_source_attributions', column_name: 'excerpt_public_use_approved' },
      { table_name: 'public_source_attributions', column_name: 'excerpt' },
    ]);

    const privileges = await database.executor.query<{
      role_name: string;
      relation_name: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `SELECT roles.role_name, relations.relation_name,
              has_table_privilege(roles.role_name, relations.relation_name, 'SELECT') AS can_select,
              has_table_privilege(roles.role_name, relations.relation_name, 'INSERT') AS can_insert,
              has_table_privilege(roles.role_name, relations.relation_name, 'UPDATE') AS can_update,
              has_table_privilege(roles.role_name, relations.relation_name, 'DELETE') AS can_delete
       FROM (VALUES
         ('waspada_public_reader'), ('waspada_l1_pipeline'),
         ('waspada_l2_grounding_reader'), ('waspada_l2_grounding_writer'),
         ('waspada_l3_coordinator'), ('waspada_l4_publication_writer')
       ) AS roles(role_name)
       CROSS JOIN (VALUES
         ('waspada.scope_name_review_decisions'),
         ('waspada.public_attribution_review_decisions')
       ) AS relations(relation_name)
       ORDER BY roles.role_name, relations.relation_name`,
    );
    assert.equal(privileges.rows.length, 12);
    assert.ok(privileges.rows.every((row) => !row.can_select && !row.can_insert && !row.can_update && !row.can_delete));

    const safeViewPrivileges = await database.executor.query<{ can_select: boolean; can_insert: boolean }>(
      `SELECT has_table_privilege('waspada_public_reader', 'waspada.public_scope_names', 'SELECT') AS can_select,
              has_table_privilege('waspada_public_reader', 'waspada.public_scope_names', 'INSERT') AS can_insert`,
    );
    assert.deepEqual(safeViewPrivileges.rows[0], { can_select: true, can_insert: false });
    const rawSourcePrivileges = await database.executor.query<{ can_read_revision: boolean; can_read_text: boolean }>(
      `SELECT has_table_privilege('waspada_public_reader', 'waspada.report_revisions', 'SELECT') AS can_read_revision,
              has_column_privilege('waspada_public_reader', 'waspada.report_revisions', 'permitted_text', 'SELECT') AS can_read_text`,
    );
    assert.deepEqual(rawSourcePrivileges.rows[0], { can_read_revision: false, can_read_text: false });

    await database.executor.execute('SET ROLE waspada_public_reader');
    try {
      const visible = await database.executor.query<{ display_name: string; excerpt: string | null }>(
        `SELECT display_name, excerpt FROM waspada.public_source_attributions
         WHERE report_revision_id = $1 AND span_start = $2`,
        [supportOne.reportRevisionId, supportOne.spanStart],
      );
      assert.equal(visible.rows[0]?.display_name, 'Synthetic Publisher Updated');
      assert.equal(visible.rows[0]?.excerpt, null);
      await assert.rejects(
        database.executor.query('SELECT * FROM waspada.public_attribution_review_decisions'),
        /permission denied/i,
      );
      await assert.rejects(
        database.executor.query('SELECT permitted_text FROM waspada.report_revisions'),
        /permission denied/i,
      );
      await assert.rejects(
        database.executor.query(
          `INSERT INTO waspada.scope_name_review_decisions
             (review_decision_id, entity_type, entity_id, locale, review_version,
              decision_status, display_name, provenance_ref, reviewer_id, decision_reason, reviewed_at)
           VALUES ('reader-write-attempt', 'place', 'place-reader-write-attempt', 'id-ID', 1,
              'approved', 'Synthetic', 'fixture-only', 'reviewer-synthetic', 'fixture-only', now())`,
        ),
        /permission denied/i,
      );
    } finally {
      await database.executor.execute('RESET ROLE');
    }
  });
});

async function insertEvidence(key: PublicSupportingEvidenceKey): Promise<number> {
  const result = await database.executor.query<{ evidence_ref_id: string | number | bigint }>(
    `INSERT INTO waspada.evidence_references
       (dataset_kind, trace_id, report_revision_id, permitted_text_hash,
        span_start, span_end, offset_unit, relation)
     VALUES ('live', $1, $2, $3, $4, $5, $6, $7)
     RETURNING evidence_ref_id`,
    [fixtureTraceId, key.reportRevisionId, key.permittedTextHash, key.spanStart, key.spanEnd,
      key.offsetUnit, key.relation],
  );
  const id = result.rows[0]?.evidence_ref_id;
  assert.ok(id !== undefined);
  return Number(id);
}

async function insertScopeDecision(input: {
  readonly reviewDecisionId: string;
  readonly key: PublicScopeNameKey;
  readonly version: number;
  readonly status: 'approved' | 'held' | 'withdrawn';
  readonly displayName?: string;
  readonly locale?: string;
}): Promise<void> {
  await database.executor.query(
    `INSERT INTO waspada.scope_name_review_decisions
       (review_decision_id, entity_type, entity_id, locale, review_version,
        decision_status, display_name, provenance_ref, reviewer_id, decision_reason, reviewed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'synthetic-test-provenance-only',
        'reviewer-synthetic-test-only', 'Authored fixture decision; no real review', $8)`,
    [input.reviewDecisionId, input.key.entityType, input.key.entityId, input.locale ?? 'id-ID',
      input.version, input.status, input.displayName ?? null, `2026-09-26T0${input.version}:00:00Z`],
  );
}

async function insertAttributionDecision(input: {
  readonly reviewDecisionId: string;
  readonly evidenceRefId: number;
  readonly key: PublicSupportingEvidenceKey;
  readonly version: number;
  readonly status: 'approved' | 'held' | 'revoked';
  readonly displayName?: string;
  readonly url?: string;
  readonly publishedAt?: string | null;
  readonly observedAt?: string | null;
}): Promise<void> {
  await database.executor.query(
    `INSERT INTO waspada.public_attribution_review_decisions
       (review_decision_id, dataset_kind, evidence_ref_id, report_revision_id,
        permitted_text_hash, span_start, span_end, offset_unit, relation, review_version,
        decision_status, rights_basis_ref, public_display_name, source_url,
        source_published_at, source_observed_at, reviewer_id, decision_reason, reviewed_at)
     VALUES ($1, 'live', $2, $3, $4, $5, $6, $7, $8, $9, $10,
        'synthetic-rights-basis-reference-only', $11, $12, $13, $14,
        'reviewer-synthetic-test-only', 'Authored fixture decision; no real rights review', $15)`,
    [input.reviewDecisionId, input.evidenceRefId, input.key.reportRevisionId, input.key.permittedTextHash,
      input.key.spanStart, input.key.spanEnd, input.key.offsetUnit, input.key.relation, input.version,
      input.status, input.displayName ?? null, input.url ?? null,
      input.publishedAt ?? null, input.observedAt ?? null, `2026-09-26T0${input.version}:30:00Z`],
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
