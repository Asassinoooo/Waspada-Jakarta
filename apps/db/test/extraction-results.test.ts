import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import {
  ExtractionResultConflictError,
  ExtractionResultReferenceError,
  ExtractionResultValidationError,
  type ExtractionResultEvidence,
  type ExtractionResultRecord,
} from '../src/extraction-results.js';
import { createRepositoryPorts, type EvidenceRelation, type NewReportRevision } from '../src/ports.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const TEST_TIME = '2026-09-26T10:00:00Z';
const REPORT_TEXT = 'Authored synthetic fixture: candidate evidence span for persistence checks.';
const TRACE_ID = 'trace-extraction-result-fixture';
const SOURCE_ID = 'source-extraction-result-fixture';
const REVISION_ID = 'revision-extraction-result-fixture';
const REPORT_HASH = sha256(REPORT_TEXT);
const SUPPORT_EVIDENCE: ExtractionResultEvidence = {
  report_revision_id: REVISION_ID,
  permitted_text_hash: REPORT_HASH,
  span_start: 0,
  span_end: Array.from(REPORT_TEXT).length,
  offset_unit: 'unicode_code_points',
  relation: 'supports',
};
const RELATIONS: readonly EvidenceRelation[] = ['supports', 'contradicts', 'updates', 'context'];

describe('L1 typed extraction-result persistence', () => {
  let database: TestDatabase;
  let ports: ReturnType<typeof createRepositoryPorts>;
  let evidence: Record<EvidenceRelation, ExtractionResultEvidence>;
  let evidenceIds: Record<EvidenceRelation, string>;

  before(async () => {
    database = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    const result = await applyMigrations(database.executor, migrations);
    assert.ok(result.applied.includes('018_l1_extraction_result_verification'));
    const reapplied = await applyMigrations(database.executor, migrations);
    assert.ok(reapplied.skipped.includes('018_l1_extraction_result_verification'));
    ports = createRepositoryPorts(database.executor);

    await ports.tracesAndAudit.createTrace({
      traceId: TRACE_ID,
      datasetKind: 'synthetic',
      startedAt: TEST_TIME,
      endedAt: null,
      outcome: 'open',
      metadata: { fixture: 'authored-synthetic-test-only' },
    });
    await database.executor.query(
      'INSERT INTO waspada.source_registry ' +
        '(source_id, trace_id, registry_version, display_name, source_kind, remit, access_method, ' +
        'approved_hosts, access_restrictions, reuse_basis, registry_status, approval_status, health_status, ' +
        'auto_acquisition_enabled, auto_publication_policy) ' +
        'VALUES ($1, $2, 1, $3, \'other\', ARRAY[\'synthetic test fixture\'], \'manual_fixture\', ' +
        'ARRAY[]::text[], ARRAY[\'synthetic only\'], ARRAY[\'authored fixture\'], \'active\', \'approved\', ' +
        '\'unknown\', false, \'never\')',
      [SOURCE_ID, TRACE_ID, 'Authored synthetic test fixture only'],
    );

    const revision: NewReportRevision = {
      datasetKind: 'synthetic',
      reportRevisionId: REVISION_ID,
      traceId: TRACE_ID,
      sourceId: SOURCE_ID,
      canonicalUrl: 'https://synthetic.invalid/' + REVISION_ID,
      sourceRevisionKey: null,
      contentHash: sha256('synthetic raw fixture only'),
      permittedText: REPORT_TEXT,
      permittedTextHash: REPORT_HASH,
      normalizationVersion: 'synthetic-test-normalizer-v1',
      publishedAt: null,
      observedAt: null,
      retrievedAt: TEST_TIME,
      validFrom: null,
      validUntil: null,
      supersedesId: null,
      revisionStatus: 'eligible',
      recordJson: { fixture: 'authored-synthetic-test-only' },
    };
    await ports.reportRevisions.create(revision);

    const spanEnd = Array.from(REPORT_TEXT).length;
    evidence = {} as Record<EvidenceRelation, ExtractionResultEvidence>;
    evidenceIds = {} as Record<EvidenceRelation, string>;
    for (const relation of RELATIONS) {
      const reference: ExtractionResultEvidence = {
        report_revision_id: REVISION_ID,
        permitted_text_hash: REPORT_HASH,
        span_start: 0,
        span_end: spanEnd,
        offset_unit: 'unicode_code_points',
        relation,
      };
      evidence[relation] = reference;
      evidenceIds[relation] = await ports.reportRevisions.createEvidenceReference({
        datasetKind: 'synthetic',
        traceId: TRACE_ID,
        reportRevisionId: REVISION_ID,
        permittedTextHash: REPORT_HASH,
        spanStart: reference.span_start,
        spanEnd: reference.span_end,
        relation,
      });
    }
  });

  after(async () => database.close());

  it('persists the closed schema 2.0 record and distinct exact links for all four relations', async () => {
    const record = makeRecord('all-relations', { evidence: RELATIONS.map((relation) => evidence[relation]) });
    assert.deepEqual(await ports.extractionResults.createOrVerify(record), record);

    const stored = await database.executor.query<{
      dataset_kind: string;
      candidate_id: string;
      trace_id: string;
      report_revision_id: string;
      category: string | null;
      record_json: unknown;
    }>(
      'SELECT dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json ' +
        'FROM waspada.extraction_results WHERE dataset_kind = $1 AND candidate_id = $2',
      [record.dataset_kind, record.candidate_id],
    );
    assert.deepEqual(stored.rows[0], {
      dataset_kind: record.dataset_kind,
      candidate_id: record.candidate_id,
      trace_id: record.trace_id,
      report_revision_id: record.report_revision_id,
      category: record.category,
      record_json: record,
    });
    assert.equal(Object.hasOwn(record, 'provider'), false);
    assert.deepEqual(
      await ports.extractionResults.findByCandidateId(record.dataset_kind, record.candidate_id),
      { outcome: 'found', record },
    );

    const linked = await readLinks(record.candidate_id);
    assert.deepEqual(linked, record.evidence.map(evidenceKey).sort());
    assert.deepEqual(linked.map((key) => JSON.parse(key)[5]).sort(), [...RELATIONS].sort());
  });

  it('persists an empty unknown extraction without inventing claims or evidence', async () => {
    const record = makeUnknownRecord('empty-unknown');
    assert.deepEqual(await ports.extractionResults.createOrVerify(record), record);
    assert.deepEqual(
      await ports.extractionResults.findByCandidateId(record.dataset_kind, record.candidate_id),
      { outcome: 'found', record },
    );
    const linked = await readLinks(record.candidate_id);
    assert.deepEqual(linked, []);
  });

  it('distinguishes an absent candidate from malformed storage and parent identity drift', async () => {
    assert.deepEqual(
      await ports.extractionResults.findByCandidateId('synthetic', 'candidate-lookup-absent'),
      { outcome: 'not_found' },
    );

    await database.executor.query(
      'INSERT INTO waspada.extraction_results ' +
        '(dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json) ' +
        'VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
      ['synthetic', 'candidate-lookup-malformed', TRACE_ID, REVISION_ID, null,
        JSON.stringify({ schema_version: '1.0' })],
    );
    assert.deepEqual(
      await ports.extractionResults.findByCandidateId('synthetic', 'candidate-lookup-malformed'),
      { outcome: 'invalid_record' },
    );

    const mismatchedRecord = makeRecord('lookup-json-candidate');
    await database.executor.query(
      'INSERT INTO waspada.extraction_results ' +
        '(dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json) ' +
        'VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
      ['synthetic', 'candidate-lookup-row-candidate', TRACE_ID, REVISION_ID,
        mismatchedRecord.category, JSON.stringify(mismatchedRecord)],
    );
    assert.deepEqual(
      await ports.extractionResults.findByCandidateId('synthetic', 'candidate-lookup-row-candidate'),
      { outcome: 'identity_conflict' },
    );
  });

  it('requires one exact supports reference whenever an extraction proposes fields', async () => {
    const empty = makeUnknownRecord('support-required');
    const proposed = [
      { category: 'disasters_weather' },
      { tags: [{ namespace: 'hazard', value: 'rain' }] },
      { event_time: { start: '2026-09-26T09:30:00Z', end: null, precision: 'exact' } },
      { scope: { place_ids: ['place-synthetic-jakarta'], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [] } },
    ];
    for (const [index, fields] of proposed.entries()) {
      const record = { ...empty, candidate_id: 'candidate-ungrounded-' + index, ...fields };
      await assertInvalid(record);
    }

    const unsupportedRelations: readonly EvidenceRelation[] = ['contradicts', 'updates', 'context'];
    const record = makeRecord('unsupported-only', {
      evidence: [evidence[unsupportedRelations[0]!]],
    });
    await assertInvalid(record);
  });

  it('rejects open, duplicate, unsupported, malformed, and over-budget contract fields before SQL', async () => {
    const base = makeUnknownRecord('closed-schema');
    const extraTop = { ...base, provider: 'fixture-provider' };
    const extraNestedEvidence = {
      ...base,
      evidence: [{ ...evidence.supports, source_id: 'unexpected' }],
    };
    const duplicateEvidence = {
      ...base,
      evidence: [evidence.supports, evidence.supports],
    };
    const unsupportedCategory = { ...base, category: 'unknown_category' };
    const malformedTag = {
      ...base,
      tags: [{ namespace: 'other', value: 'fixture' }],
    };
    const duplicateScope = {
      ...base,
      scope: { ...base.scope, place_ids: ['place-duplicate', 'place-duplicate'] },
    };
    const invalidTime = {
      ...base,
      event_time: { start: 'not-a-date', end: null, precision: 'date' },
    };
    const invalidUnknownTime = {
      ...base,
      event_time: { start: '2026-09-26T09:30:00Z', end: null, precision: 'unknown' },
    };
    const invalidModelCapability = {
      ...base,
      model_run: { ...base.model_run, capability: 'reasoning' },
    };
    const extraModelMetadata = {
      ...base,
      model_run: { ...base.model_run, provider: 'fixture-provider' },
    };
    const excessiveModelUsage = {
      ...base,
      model_run: { ...base.model_run, input_tokens: 12_000, output_tokens: 1 },
    };
    const duplicateUnknownFields = {
      ...base,
      unknown_fields: ['category', 'category', 'event_time'],
    };
    const extraScopeField = {
      ...base,
      scope: { ...base.scope, radius_m: 100 },
    };

    for (const value of [
      extraTop,
      extraNestedEvidence,
      duplicateEvidence,
      unsupportedCategory,
      malformedTag,
      duplicateScope,
      invalidTime,
      invalidUnknownTime,
      invalidModelCapability,
      extraModelMetadata,
      excessiveModelUsage,
      duplicateUnknownFields,
      extraScopeField,
    ]) {
      await assertInvalid(value);
    }
  });

  it('rejects revision reuse across datasets, stored hash drift, missing traces, and missing exact evidence', async () => {
    const wrongDataset = makeRecord('wrong-dataset', { dataset_kind: 'historical' });
    await assertReferenceFailure(wrongDataset, 'report_revision', 'not_found');

    const wrongHash = makeRecord('wrong-hash', {
      evidence: [{ ...evidence.supports, permitted_text_hash: 'f'.repeat(64) }],
    });
    await assertReferenceFailure(wrongHash, 'report_revision', 'hash_mismatch');

    const wrongTrace = makeRecord('wrong-trace', { trace_id: 'trace-extraction-not-found' });
    await assertReferenceFailure(wrongTrace, 'trace', 'not_found');

    const missingEvidence = makeRecord('missing-evidence', {
      evidence: [{
        ...evidence.supports,
        span_start: 1,
        span_end: 2,
      }],
    });
    await assertReferenceFailure(missingEvidence, 'evidence', 'not_found');

    const absentParent = makeRecord('missing-revision', {
      report_revision_id: 'revision-not-present',
      evidence: [{ ...evidence.supports, report_revision_id: 'revision-not-present' }],
    });
    await assertReferenceFailure(absentParent, 'report_revision', 'not_found');
  });

  it('returns success for an identical retry and conflicts on parent or link drift', async () => {
    const record = makeRecord('retry');
    assert.deepEqual(await ports.extractionResults.createOrVerify(record), record);
    assert.deepEqual(await ports.extractionResults.createOrVerify(record), record);
    assert.deepEqual(await readCounts(record.candidate_id), { parents: 1, links: 1 });

    const changedRecord = {
      ...record,
      model_run: { ...record.model_run, prompt_version: 'fixture-prompt-v2' },
    };
    await assert.rejects(
      ports.extractionResults.createOrVerify(changedRecord),
      ExtractionResultConflictError,
    );

    const linkDrift = makeRecord('link-drift');
    await ports.extractionResults.createOrVerify(linkDrift);
    await database.executor.query(
      'INSERT INTO waspada.extraction_evidence (dataset_kind, candidate_id, evidence_ref_id) ' +
        'VALUES ($1, $2, $3)',
      ['synthetic', linkDrift.candidate_id, evidenceIds.contradicts],
    );
    assert.deepEqual(
      await ports.extractionResults.findByCandidateId(linkDrift.dataset_kind, linkDrift.candidate_id),
      { outcome: 'identity_conflict' },
    );
    await assert.rejects(
      ports.extractionResults.createOrVerify(linkDrift),
      ExtractionResultConflictError,
    );
  });

  it('rolls back the result row and every link when a link write fails', async () => {
    const record = makeRecord('rollback');
    await database.executor.execute(
      "CREATE FUNCTION waspada.fail_extraction_link_fixture() RETURNS trigger " +
        "LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic extraction link failure'; END; $$",
    );
    await database.executor.execute(
      'CREATE TRIGGER fail_extraction_link_fixture BEFORE INSERT ON waspada.extraction_evidence ' +
        'FOR EACH ROW EXECUTE FUNCTION waspada.fail_extraction_link_fixture()',
    );
    try {
      await assert.rejects(
        ports.extractionResults.createOrVerify(record),
        /synthetic extraction link failure/,
      );
      assert.deepEqual(await readCounts(record.candidate_id), { parents: 0, links: 0 });
    } finally {
      await database.executor.execute('DROP TRIGGER fail_extraction_link_fixture ON waspada.extraction_evidence');
      await database.executor.execute('DROP FUNCTION waspada.fail_extraction_link_fixture()');
    }
  });

  it('works under the real L1 role and denies unrelated reads and mutation privileges', async () => {
    const role = await database.executor.query<{
      parent_table_select: boolean;
      link_table_select: boolean;
      parent_json_select: boolean;
      link_id_select: boolean;
      parent_insert: boolean;
      link_insert: boolean;
      parent_update: boolean;
      parent_delete: boolean;
      link_update: boolean;
      link_delete: boolean;
      unrelated_select: boolean;
    }>(
      "SELECT " +
        "has_table_privilege('waspada_l1_pipeline', 'waspada.extraction_results', 'SELECT') AS parent_table_select, " +
        "has_table_privilege('waspada_l1_pipeline', 'waspada.extraction_evidence', 'SELECT') AS link_table_select, " +
        "has_column_privilege('waspada_l1_pipeline', 'waspada.extraction_results', 'record_json', 'SELECT') AS parent_json_select, " +
        "has_column_privilege('waspada_l1_pipeline', 'waspada.extraction_evidence', 'evidence_ref_id', 'SELECT') AS link_id_select, " +
        "has_table_privilege('waspada_l1_pipeline', 'waspada.extraction_results', 'INSERT') AS parent_insert, " +
        "has_table_privilege('waspada_l1_pipeline', 'waspada.extraction_evidence', 'INSERT') AS link_insert, " +
        "has_table_privilege('waspada_l1_pipeline', 'waspada.extraction_results', 'UPDATE') AS parent_update, " +
        "has_table_privilege('waspada_l1_pipeline', 'waspada.extraction_results', 'DELETE') AS parent_delete, " +
        "has_table_privilege('waspada_l1_pipeline', 'waspada.extraction_evidence', 'UPDATE') AS link_update, " +
        "has_table_privilege('waspada_l1_pipeline', 'waspada.extraction_evidence', 'DELETE') AS link_delete, " +
        "has_column_privilege('waspada_l1_pipeline', 'waspada.grounding_contexts', 'record_json', 'SELECT') AS unrelated_select",
    );
    assert.deepEqual(role.rows[0], {
      parent_table_select: false,
      link_table_select: false,
      parent_json_select: true,
      link_id_select: true,
      parent_insert: true,
      link_insert: true,
      parent_update: false,
      parent_delete: false,
      link_update: false,
      link_delete: false,
      unrelated_select: false,
    });

    const record = makeRecord('l1-role');
    await database.executor.execute('SET ROLE waspada_l1_pipeline');
    try {
      assert.deepEqual(await ports.extractionResults.createOrVerify(record), record);
      assert.deepEqual(await ports.extractionResults.createOrVerify(record), record);
      assert.deepEqual(
        await ports.extractionResults.findByCandidateId(record.dataset_kind, record.candidate_id),
        { outcome: 'found', record },
      );
      assert.deepEqual(
        await ports.extractionResults.findByCandidateId('synthetic', 'candidate-l1-role-absent'),
        { outcome: 'not_found' },
      );
      await assertPermissionDenied(
        database,
        'SELECT record_json FROM waspada.grounding_contexts LIMIT 1',
      );
      await assertPermissionDenied(
        database,
        'SELECT * FROM waspada.event_versions LIMIT 1',
      );
      await assertPermissionDenied(
        database,
        "UPDATE waspada.extraction_results SET category = NULL WHERE dataset_kind = 'synthetic' " +
          "AND candidate_id = '" + record.candidate_id + "'",
      );
      await assertPermissionDenied(
        database,
        "DELETE FROM waspada.extraction_evidence WHERE dataset_kind = 'synthetic' " +
          "AND candidate_id = '" + record.candidate_id + "'",
      );
    } finally {
      await database.executor.execute('RESET ROLE');
    }
  });

  async function readLinks(candidateId: string): Promise<string[]> {
    const result = await database.executor.query<{
      report_revision_id: string;
      permitted_text_hash: string;
      span_start: number;
      span_end: number;
      offset_unit: 'unicode_code_points';
      relation: EvidenceRelation;
    }>(
      'SELECT reference.report_revision_id, reference.permitted_text_hash, reference.span_start, ' +
        'reference.span_end, reference.offset_unit, reference.relation ' +
        'FROM waspada.extraction_evidence AS link ' +
        'JOIN waspada.evidence_references AS reference ' +
        'ON reference.dataset_kind = link.dataset_kind AND reference.evidence_ref_id = link.evidence_ref_id ' +
        'WHERE link.dataset_kind = $1 AND link.candidate_id = $2 ORDER BY reference.relation',
      ['synthetic', candidateId],
    );
    return result.rows.map((reference) => evidenceKey({
      report_revision_id: reference.report_revision_id,
      permitted_text_hash: reference.permitted_text_hash,
      span_start: reference.span_start,
      span_end: reference.span_end,
      offset_unit: reference.offset_unit,
      relation: reference.relation,
    })).sort();
  }

  async function readCounts(candidateId: string): Promise<{ parents: number; links: number }> {
    const result = await database.executor.query<{ parents: number; links: number }>(
      'SELECT (SELECT count(*)::integer FROM waspada.extraction_results ' +
        'WHERE dataset_kind = $1 AND candidate_id = $2) AS parents, ' +
        '(SELECT count(*)::integer FROM waspada.extraction_evidence ' +
        'WHERE dataset_kind = $1 AND candidate_id = $2) AS links',
      ['synthetic', candidateId],
    );
    return result.rows[0]!;
  }

  async function assertInvalid(value: unknown): Promise<void> {
    await assert.rejects(
      ports.extractionResults.createOrVerify(value as ExtractionResultRecord),
      (error: unknown) => error instanceof ExtractionResultValidationError,
    );
  }

  async function assertReferenceFailure(
    record: ExtractionResultRecord,
    kind: 'trace' | 'report_revision' | 'evidence',
    reason: 'not_found' | 'hash_mismatch',
  ): Promise<void> {
    await assert.rejects(
      ports.extractionResults.createOrVerify(record),
      (error: unknown) => error instanceof ExtractionResultReferenceError
        && error.referenceKind === kind && error.reason === reason,
    );
  }
});

function makeRecord(
  suffix: string,
  overrides: Partial<ExtractionResultRecord> = {},
): ExtractionResultRecord {
  return {
    schema_version: '2.0',
    trace_id: TRACE_ID,
    record_type: 'ExtractionResult',
    dataset_kind: 'synthetic',
    candidate_id: 'candidate-extraction-' + suffix,
    report_revision_id: REVISION_ID,
    category: 'disasters_weather',
    tags: [{ namespace: 'hazard', value: 'heavy_rain' }],
    event_time: { start: '2026-09-26T09:30:00Z', end: null, precision: 'exact' },
    scope: {
      place_ids: ['place-synthetic-central-jakarta'],
      service_ids: [],
      institution_ids: [],
      audience_ids: [],
      geometry_ids: [],
    },
    evidence: [SUPPORT_EVIDENCE],
    unknown_fields: [],
    model_run: {
      capability: 'extraction',
      model_version: 'synthetic-fixture-model-v1',
      prompt_version: 'synthetic-fixture-prompt-v1',
      input_tokens: 10,
      output_tokens: 8,
    },
    ...overrides,
  };
}

function makeUnknownRecord(
  suffix: string,
  overrides: Partial<ExtractionResultRecord> = {},
): ExtractionResultRecord {
  return makeRecord(suffix, {
    category: null,
    tags: [],
    event_time: { start: null, end: null, precision: 'unknown' },
    scope: {
      place_ids: [],
      service_ids: [],
      institution_ids: [],
      audience_ids: [],
      geometry_ids: [],
    },
    evidence: [],
    unknown_fields: ['category', 'event_time'],
    ...overrides,
  });
}

function evidenceKey(reference: ExtractionResultEvidence): string {
  return JSON.stringify([
    reference.report_revision_id,
    reference.permitted_text_hash,
    reference.span_start,
    reference.span_end,
    reference.offset_unit,
    reference.relation,
  ]);
}

async function assertPermissionDenied(database: TestDatabase, statement: string): Promise<void> {
  await assert.rejects(
    database.executor.query(statement),
    (error: unknown) => typeof error === 'object' && error !== null
      && 'message' in error && String(error.message).toLowerCase().includes('permission denied'),
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
