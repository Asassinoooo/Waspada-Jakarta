import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createRepositoryPorts, type DatasetKind, type EvidenceRelation } from '../src/ports.js';
import {
  GroundingContextConflictError,
  GroundingContextReferenceError,
  GroundingContextValidationError,
  type GroundingContextRecord,
  type GroundingEvidenceReference,
} from '../src/grounding-contexts.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const TEST_TIME = '2026-09-26T10:00:00Z';
const BASE_TEXT = 'Synthetic fixture evidence span for local persistence checks.';

describe('L2 canonical grounding-context persistence', () => {
  let database: TestDatabase;
  let ports: ReturnType<typeof createRepositoryPorts>;

  before(async () => {
    database = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    const result = await applyMigrations(database.executor, migrations);
    assert.ok(result.applied.includes('010_l2_grounding_context_writer'));
    ports = createRepositoryPorts(database.executor);
  });

  after(async () => database.close());

  it('persists the closed schema 2.0 record, exact links, normalized columns, and caller sufficiency', async () => {
    const seed = await seedCandidate('canonical');
    const record = makeContext(seed, 'canonical', { sufficient: true });
    assert.deepEqual(await ports.groundingContexts.createOrVerify(record), record);

    const stored = await database.executor.query<{
      dataset_kind: string; trace_id: string; context_id: string; candidate_id: string;
      retrieval_version: string; index_version: string; sufficient: boolean; record_json: unknown;
    }>(
      'SELECT dataset_kind, trace_id, context_id, candidate_id, retrieval_version, index_version, ' +
        'sufficient, record_json FROM waspada.grounding_contexts ' +
        'WHERE dataset_kind = $1 AND context_id = $2',
      [record.dataset_kind, record.context_id],
    );
    assert.deepEqual(stored.rows[0], {
      dataset_kind: record.dataset_kind, trace_id: record.trace_id, context_id: record.context_id,
      candidate_id: record.candidate_id, retrieval_version: record.retrieval_version,
      index_version: record.index_version, sufficient: true, record_json: record,
    });
    assert.equal(Object.hasOwn(record.evidence[0]!, 'text'), false);
    assert.equal(Object.hasOwn(record.evidence[0]!, 'evidence_ref_id'), false);
    assert.deepEqual(await readEvidenceLinks(database, record), [seed.evidence]);

    const second = makeContext(seed, 'caller-sufficiency-false', { sufficient: false });
    await ports.groundingContexts.createOrVerify(second);
    const sufficiency = await database.executor.query<{ sufficient: boolean; record_sufficient: boolean }>(
      'SELECT sufficient, record_json->>\'sufficient\' = \'true\' AS record_sufficient ' +
        'FROM waspada.grounding_contexts WHERE dataset_kind = $1 AND context_id = $2',
      [second.dataset_kind, second.context_id],
    );
    assert.deepEqual(sufficiency.rows[0], { sufficient: false, record_sufficient: false });
  });

  it('returns the stable prior record on retry and a typed conflict on payload or link drift', async () => {
    const seed = await seedCandidate('retry');
    const record = makeContext(seed, 'retry');
    const initial = await ports.groundingContexts.createOrVerify(record);
    assert.deepEqual(await ports.groundingContexts.createOrVerify(record), initial);

    const counts = await database.executor.query<{ contexts: string; evidence: string }>(
      'SELECT (SELECT count(*)::text FROM waspada.grounding_contexts ' +
        'WHERE dataset_kind = $1 AND context_id = $2) AS contexts, ' +
        '(SELECT count(*)::text FROM waspada.grounding_evidence ' +
        'WHERE dataset_kind = $1 AND context_id = $2) AS evidence',
      [record.dataset_kind, record.context_id],
    );
    assert.deepEqual(counts.rows[0], { contexts: '1', evidence: '1' });
    await assertConflict({ ...record, sufficient: !record.sufficient });

    const badNormalized = makeContext(seed, 'normalized-column-drift');
    await insertRawContext(database, badNormalized, 'different-version');
    await assertConflict(badNormalized);

    const badLinks = makeContext(seed, 'link-set-drift');
    await insertRawContext(database, badLinks);
    await assertConflict(badLinks);
    const unchanged = await database.executor.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waspada.grounding_evidence ' +
        'WHERE dataset_kind = $1 AND context_id = $2',
      [badLinks.dataset_kind, badLinks.context_id],
    );
    assert.equal(unchanged.rows[0]?.count, '0');
  });

  it('rejects noncanonical fields, duplicate links, malformed values, and offsets beyond schema 2.0 bounds', async () => {
    const seed = await seedCandidate('validation');
    const record = makeContext(seed, 'validation');
    await assertValidationError({ ...record, retrieved_text: BASE_TEXT });
    await assertValidationError({
      ...record,
      evidence: [{ ...record.evidence[0]!, evidence_ref_id: '1' }],
    });
    await assertValidationError({ ...record, evidence: [record.evidence[0]!, record.evidence[0]!] });
    await assertValidationError({ ...record, schema_version: undefined });
    await assertValidationError({
      ...record,
      evidence: [{ ...record.evidence[0]!, span_end: 10_000_001 }],
    });
    const extraNestedField = {
      ...record,
      candidate_events: [{ event_id: 'event-unused', event_version: 1, excerpt: 'private text' }],
    };
    await assertValidationError(extraNestedField);

    const contexts = await database.executor.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waspada.grounding_contexts WHERE candidate_id = $1',
      [seed.candidateId],
    );
    assert.equal(contexts.rows[0]?.count, '0');
  });

  it('counts schema Strings limits in code points and preserves repeated revision states', async () => {
    const seed = await seedCandidate('unicode-validation');
    const astralCharacter = '😀';
    const maxLengthRecord = makeContext(seed, 'unicode-500', {
      missing_fields: [astralCharacter.repeat(500)],
    });
    assert.deepEqual(await ports.groundingContexts.createOrVerify(maxLengthRecord), maxLengthRecord);
    await assertValidationError(makeContext(seed, 'unicode-501', {
      missing_fields: [astralCharacter.repeat(501)],
    }));

    const revisionState = maxLengthRecord.revision_states[0]!;
    const repeatedRevisionRecord = makeContext(seed, 'repeated-revision-state', {
      revision_states: [revisionState, revisionState],
    });
    assert.deepEqual(
      await ports.groundingContexts.createOrVerify(repeatedRevisionRecord),
      repeatedRevisionRecord,
    );
    const persisted = await database.executor.query<{ record_json: unknown }>(
      'SELECT record_json FROM waspada.grounding_contexts WHERE dataset_kind = $1 AND context_id = $2',
      [repeatedRevisionRecord.dataset_kind, repeatedRevisionRecord.context_id],
    );
    assert.deepEqual(persisted.rows[0]?.record_json, repeatedRevisionRecord);
  });

  it('resolves only an existing exact same-dataset evidence identity and never creates L1 evidence', async () => {
    const seed = await seedCandidate('identity', 'synthetic', 'updates');
    const before = await evidenceCount(seed);
    assert.equal(before, '1');
    await ports.groundingContexts.createOrVerify(makeContext(seed, 'identity'));

    await assertMissingEvidence({
      ...makeContext(seed, 'wrong-span'),
      evidence: [{ ...seed.evidence, span_start: seed.evidence.span_start + 1 }],
    });
    await assertMissingEvidence({
      ...makeContext(seed, 'wrong-hash'),
      evidence: [{ ...seed.evidence, permitted_text_hash: '0'.repeat(64) }],
    });
    await assertMissingEvidence({
      ...makeContext(seed, 'wrong-relation'),
      evidence: [{ ...seed.evidence, relation: 'supports' }],
    });
    await assertMissingEvidence({
      ...makeContext(seed, 'cross-dataset-evidence'),
      dataset_kind: 'historical',
    });
    assert.equal(await evidenceCount(seed), before);
  });

  it('resolves event versions and decisions in the same dataset, then rolls every link back on failure', async () => {
    const seed = await seedCandidate('event-links');
    const target = await seedEventAndDecision(seed, 'event-links');
    const record = makeContext(seed, 'event-links', {
      candidate_events: [{ event_id: target.eventId, event_version: 1 }],
      prior_decision_ids: [target.decisionId],
    });
    await ports.groundingContexts.createOrVerify(record);
    assert.deepEqual(await readEventDecisionLinks(database, record), {
      events: [{ event_id: target.eventId, event_version: 1 }],
      decisions: [target.decisionId],
    });

    await assertMissingReference({
      ...record,
      context_id: 'context-event-missing',
      candidate_events: [{ event_id: 'event-missing', event_version: 1 }],
    }, 'candidate_event');
    await assertMissingReference({
      ...record,
      context_id: 'context-decision-missing',
      prior_decision_ids: ['decision-missing'],
    }, 'prior_decision');
    await assertMissingReference({
      ...record,
      context_id: 'context-event-cross-dataset',
      dataset_kind: 'historical',
      evidence: [],
      revision_states: [],
    }, 'candidate_event');
    await assertMissingReference({
      ...record,
      context_id: 'context-decision-cross-dataset',
      dataset_kind: 'historical',
      evidence: [],
      revision_states: [],
      candidate_events: [],
    }, 'prior_decision');

    const rollback = makeContext(seed, 'rollback', {
      candidate_events: [{ event_id: target.eventId, event_version: 1 }],
      prior_decision_ids: [target.decisionId],
    });
    await database.executor.execute(
      'CREATE FUNCTION waspada.fail_grounding_context_prior_link_test() RETURNS trigger ' +
        'LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'fixture link failure\'; END; $$',
    );
    await database.executor.execute(
      'CREATE TRIGGER fail_grounding_context_prior_link_test ' +
        'BEFORE INSERT ON waspada.grounding_prior_decisions ' +
        'FOR EACH ROW EXECUTE FUNCTION waspada.fail_grounding_context_prior_link_test()',
    );
    try {
      await assert.rejects(ports.groundingContexts.createOrVerify(rollback), /fixture link failure/);
    } finally {
      await database.executor.execute(
        'DROP TRIGGER fail_grounding_context_prior_link_test ON waspada.grounding_prior_decisions',
      );
      await database.executor.execute('DROP FUNCTION waspada.fail_grounding_context_prior_link_test()');
    }
    const counts = await database.executor.query<{
      contexts: string; evidence: string; events: string; decisions: string;
    }>(
      'SELECT (SELECT count(*)::text FROM waspada.grounding_contexts WHERE context_id = $1) AS contexts, ' +
        '(SELECT count(*)::text FROM waspada.grounding_evidence WHERE context_id = $1) AS evidence, ' +
        '(SELECT count(*)::text FROM waspada.grounding_candidate_events WHERE context_id = $1) AS events, ' +
        '(SELECT count(*)::text FROM waspada.grounding_prior_decisions WHERE context_id = $1) AS decisions',
      [rollback.context_id],
    );
    assert.deepEqual(counts.rows[0], { contexts: '0', evidence: '0', events: '0', decisions: '0' });
  });

  it('uses the exact NOLOGIN writer under SET ROLE and denies unrelated reads and mutation', async () => {
    const seed = await seedCandidate('writer');
    const target = await seedEventAndDecision(seed, 'writer');
    const record = makeContext(seed, 'writer', {
      candidate_events: [{ event_id: target.eventId, event_version: 1 }],
      prior_decision_ids: [target.decisionId],
    });
    const role = await database.executor.query<{
      rolcanlogin: boolean; rolinherit: boolean; rolsuper: boolean; rolcreatedb: boolean;
      rolcreaterole: boolean; rolreplication: boolean; rolbypassrls: boolean;
    }>(
      'SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls ' +
        'FROM pg_roles WHERE rolname = \'waspada_l2_grounding_writer\'',
    );
    assert.deepEqual(role.rows[0], {
      rolcanlogin: false, rolinherit: false, rolsuper: false, rolcreatedb: false,
      rolcreaterole: false, rolreplication: false, rolbypassrls: false,
    });
    const schema = await database.executor.query<{ can_use: boolean; can_create: boolean }>(
      'SELECT has_schema_privilege(\'waspada_l2_grounding_writer\', \'waspada\', \'USAGE\') AS can_use, ' +
        'has_schema_privilege(\'waspada_l2_grounding_writer\', \'waspada\', \'CREATE\') AS can_create',
    );
    assert.deepEqual(schema.rows[0], { can_use: true, can_create: false });
    await assertExactPrivileges(database);
    await assertMigrationReapplication(database);

    await database.executor.execute('SET ROLE waspada_l2_grounding_writer');
    try {
      const first = await ports.groundingContexts.createOrVerify(record);
      assert.deepEqual(await ports.groundingContexts.createOrVerify(record), first);
      assert.deepEqual(await readEventDecisionLinks(database, record), {
        events: [{ event_id: target.eventId, event_version: 1 }],
        decisions: [target.decisionId],
      });

      await assertPermissionDenied('SELECT permitted_text FROM waspada.report_revisions LIMIT 1');
      await assertPermissionDenied('SELECT * FROM waspada.audit_records LIMIT 1');
      await assertPermissionDenied('SELECT * FROM waspada.event_versions LIMIT 1');
      await assertPermissionDenied('INSERT INTO waspada.evidence_references ' +
        '(dataset_kind, trace_id, report_revision_id, permitted_text_hash, span_start, span_end, offset_unit, relation) ' +
        'VALUES (\'synthetic\', \'trace-writer\', \'revision-writer\', \'' +
        seed.evidence.permitted_text_hash + '\', 0, 1, \'unicode_code_points\', \'supports\')');
      await assertPermissionDenied('INSERT INTO waspada.event_versions ' +
        '(dataset_kind, event_id, version, trace_id, supersedes_version, title, summary, category, lifecycle, ' +
        'publication_status, withdrawal_reason, publication_decision_id, published_at, withdrawn_at, record_json) ' +
        'VALUES (\'synthetic\', \'unauthorized-event\', 1, \'trace-writer\', NULL, \'x\', \'x\', ' +
        '\'group_specific_critical_notices\', \'unknown\', \'withdrawn\', \'other\', \'x\', NULL, ' +
        '\'2026-09-26T10:00:00Z\', \'{"claims":[],"impact_refs":[]}\')');
      await assertPermissionDenied('INSERT INTO waspada.publication_decisions ' +
        '(dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id, event_version, ' +
        'reviewer_id, decided_at, record_json) VALUES (\'synthetic\', \'unauthorized-decision\', ' +
        '\'trace-writer\', \'missing\', \'policy\', NULL, NULL, NULL, \'2026-09-26T10:00:00Z\', ' +
        '\'{"fixture":"synthetic-test-only"}\')');
      await assertPermissionDenied('UPDATE waspada.grounding_contexts SET sufficient = false ' +
        'WHERE dataset_kind = \'synthetic\' AND context_id = \'' + record.context_id + '\'');
      await assertPermissionDenied('DELETE FROM waspada.grounding_evidence WHERE dataset_kind = \'synthetic\' ' +
        'AND context_id = \'' + record.context_id + '\'');
      await assertPermissionDenied('DELETE FROM waspada.grounding_candidate_events WHERE dataset_kind = \'synthetic\' ' +
        'AND context_id = \'' + record.context_id + '\'');
      await assertPermissionDenied('DELETE FROM waspada.grounding_prior_decisions WHERE dataset_kind = \'synthetic\' ' +
        'AND context_id = \'' + record.context_id + '\'');
    } finally {
      await database.executor.execute('RESET ROLE');
    }
  });

  async function assertExactPrivileges(db: TestDatabase): Promise<void> {
    const columns = await db.executor.query<{
      table_name: string; column_name: string; can_select: boolean; can_insert: boolean;
      can_update: boolean; can_references: boolean;
    }>(
      'SELECT table_class.relname AS table_name, column_meta.attname AS column_name, ' +
        'has_column_privilege(\'waspada_l2_grounding_writer\', table_class.oid, column_meta.attnum, \'SELECT\') AS can_select, ' +
        'has_column_privilege(\'waspada_l2_grounding_writer\', table_class.oid, column_meta.attnum, \'INSERT\') AS can_insert, ' +
        'has_column_privilege(\'waspada_l2_grounding_writer\', table_class.oid, column_meta.attnum, \'UPDATE\') AS can_update, ' +
        'has_column_privilege(\'waspada_l2_grounding_writer\', table_class.oid, column_meta.attnum, \'REFERENCES\') AS can_references ' +
        'FROM pg_class AS table_class JOIN pg_namespace AS table_schema ' +
        'ON table_schema.oid = table_class.relnamespace ' +
        'JOIN pg_attribute AS column_meta ON column_meta.attrelid = table_class.oid ' +
        'WHERE table_schema.nspname = \'waspada\' AND table_class.relkind IN (\'r\', \'p\') ' +
        'AND column_meta.attnum > 0 AND NOT column_meta.attisdropped ' +
        'ORDER BY table_class.relname, column_meta.attname',
    );
    const expected = new Set<string>();
    const expect = (table: string, privilege: 'select' | 'insert', names: readonly string[]) => {
      for (const name of names) expected.add(table + '.' + name + '.' + privilege);
    };
    expect('evidence_references', 'select', [
      'dataset_kind', 'evidence_ref_id', 'report_revision_id', 'permitted_text_hash',
      'span_start', 'span_end', 'offset_unit', 'relation',
    ]);
    expect('event_versions', 'select', ['dataset_kind', 'event_id', 'version']);
    expect('publication_decisions', 'select', ['dataset_kind', 'decision_id']);
    const context = ['dataset_kind', 'context_id', 'trace_id', 'candidate_id',
      'retrieval_version', 'index_version', 'sufficient', 'record_json'];
    const evidenceLinks = ['dataset_kind', 'context_id', 'evidence_ref_id'];
    const eventLinks = ['dataset_kind', 'context_id', 'event_id', 'event_version'];
    const decisionLinks = ['dataset_kind', 'context_id', 'decision_id'];
    expect('grounding_contexts', 'select', context);
    expect('grounding_contexts', 'insert', context);
    expect('grounding_evidence', 'select', evidenceLinks);
    expect('grounding_evidence', 'insert', evidenceLinks);
    expect('grounding_candidate_events', 'select', eventLinks);
    expect('grounding_candidate_events', 'insert', eventLinks);
    expect('grounding_prior_decisions', 'select', decisionLinks);
    expect('grounding_prior_decisions', 'insert', decisionLinks);

    const actual = new Set<string>();
    for (const row of columns.rows) {
      for (const [privilege, granted] of [
        ['select', row.can_select], ['insert', row.can_insert],
        ['update', row.can_update], ['references', row.can_references],
      ] as const) {
        if (granted) actual.add(row.table_name + '.' + row.column_name + '.' + privilege);
      }
    }
    assert.deepEqual([...actual].sort(), [...expected].sort());

    const tables = await db.executor.query<{
      can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean;
      can_truncate: boolean; can_references: boolean; can_trigger: boolean;
    }>(
      'SELECT has_table_privilege(\'waspada_l2_grounding_writer\', table_class.oid, \'SELECT\') AS can_select, ' +
        'has_table_privilege(\'waspada_l2_grounding_writer\', table_class.oid, \'INSERT\') AS can_insert, ' +
        'has_table_privilege(\'waspada_l2_grounding_writer\', table_class.oid, \'UPDATE\') AS can_update, ' +
        'has_table_privilege(\'waspada_l2_grounding_writer\', table_class.oid, \'DELETE\') AS can_delete, ' +
        'has_table_privilege(\'waspada_l2_grounding_writer\', table_class.oid, \'TRUNCATE\') AS can_truncate, ' +
        'has_table_privilege(\'waspada_l2_grounding_writer\', table_class.oid, \'REFERENCES\') AS can_references, ' +
        'has_table_privilege(\'waspada_l2_grounding_writer\', table_class.oid, \'TRIGGER\') AS can_trigger ' +
        'FROM pg_class AS table_class JOIN pg_namespace AS table_schema ' +
        'ON table_schema.oid = table_class.relnamespace ' +
        'WHERE table_schema.nspname = \'waspada\' AND table_class.relkind IN (\'r\', \'p\')',
    );
    assert.equal(tables.rows.some((row) =>
      row.can_select || row.can_insert || row.can_update || row.can_delete || row.can_truncate ||
      row.can_references || row.can_trigger), false);
    const sequences = await db.executor.query<{ can_usage: boolean; can_select: boolean; can_update: boolean }>(
      'SELECT has_sequence_privilege(\'waspada_l2_grounding_writer\', sequence_class.oid, \'USAGE\') AS can_usage, ' +
        'has_sequence_privilege(\'waspada_l2_grounding_writer\', sequence_class.oid, \'SELECT\') AS can_select, ' +
        'has_sequence_privilege(\'waspada_l2_grounding_writer\', sequence_class.oid, \'UPDATE\') AS can_update ' +
        'FROM pg_class AS sequence_class JOIN pg_namespace AS sequence_schema ' +
        'ON sequence_schema.oid = sequence_class.relnamespace WHERE sequence_schema.nspname = \'waspada\' ' +
        'AND sequence_class.relkind = \'S\'',
    );
    assert.equal(sequences.rows.some((row) => row.can_usage || row.can_select || row.can_update), false);
    const reader = await db.executor.query(
      'SELECT has_table_privilege(\'waspada_l2_grounding_reader\', \'waspada.grounding_contexts\', \'INSERT\') AS can_insert, ' +
        'has_table_privilege(\'waspada_l2_grounding_reader\', \'waspada.grounding_contexts\', \'UPDATE\') AS can_update, ' +
        'has_table_privilege(\'waspada_l2_grounding_reader\', \'waspada.grounding_contexts\', \'DELETE\') AS can_delete, ' +
        'has_table_privilege(\'waspada_l2_grounding_reader\', \'waspada.grounding_contexts\', \'TRUNCATE\') AS can_truncate, ' +
        'has_table_privilege(\'waspada_l2_grounding_reader\', \'waspada.grounding_contexts\', \'REFERENCES\') AS can_references, ' +
        'has_table_privilege(\'waspada_l2_grounding_reader\', \'waspada.grounding_contexts\', \'TRIGGER\') AS can_trigger',
    );
    assert.deepEqual(reader.rows[0], {
      can_insert: false, can_update: false, can_delete: false, can_truncate: false,
      can_references: false, can_trigger: false,
    });
  }
  async function seedCandidate(
    suffix: string,
    datasetKind: DatasetKind = 'synthetic',
    relation: EvidenceRelation = 'supports',
  ): Promise<Seed> {
    const traceId = 'trace-' + suffix;
    const sourceId = 'source-' + suffix;
    const reportRevisionId = 'revision-' + suffix;
    const candidateId = 'candidate-' + suffix;
    const text = BASE_TEXT + ' ' + suffix;
    await database.executor.query(
      'INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata) ' +
        'VALUES ($1, $2, $3, \'open\', $4::jsonb)',
      [traceId, datasetKind, TEST_TIME, JSON.stringify({ fixture: 'synthetic-test-only' })],
    );
    await database.executor.query(
      'INSERT INTO waspada.source_registry ' +
        '(source_id, trace_id, registry_version, display_name, source_kind, remit, access_method, ' +
        'approved_hosts, access_restrictions, reuse_basis, registry_status, approval_status, health_status, ' +
        'auto_acquisition_enabled, auto_publication_policy) ' +
        'VALUES ($1, $2, 1, $3, \'other\', ARRAY[\'synthetic test fixture\'], \'manual_fixture\', ' +
        'ARRAY[]::text[], ARRAY[\'synthetic only\'], ARRAY[\'test fixture\'], \'active\', \'approved\', ' +
        '\'unknown\', false, \'never\')',
      [sourceId, traceId, 'Synthetic fixture ' + suffix],
    );
    const revision = {
      datasetKind, reportRevisionId, traceId, sourceId,
      canonicalUrl: 'https://synthetic.invalid/' + reportRevisionId,
      sourceRevisionKey: null,
      contentHash: sha256('synthetic raw fixture ' + suffix),
      permittedText: text,
      permittedTextHash: sha256(text),
      normalizationVersion: 'synthetic-test-normalizer-v1',
      publishedAt: null, observedAt: null, retrievedAt: TEST_TIME,
      validFrom: null, validUntil: null, supersedesId: null,
      revisionStatus: 'eligible' as const,
      recordJson: { fixture: 'synthetic-test-only' },
    };
    await ports.reportRevisions.create(revision);
    const evidence: GroundingEvidenceReference = {
      report_revision_id: reportRevisionId,
      permitted_text_hash: revision.permittedTextHash,
      span_start: 0,
      span_end: Array.from(text).length,
      offset_unit: 'unicode_code_points',
      relation,
    };
    await ports.reportRevisions.createEvidenceReference({
      datasetKind, traceId, reportRevisionId, permittedTextHash: revision.permittedTextHash,
      spanStart: evidence.span_start, spanEnd: evidence.span_end, relation,
    });
    await database.executor.query(
      'INSERT INTO waspada.extraction_results ' +
        '(dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json) ' +
        'VALUES ($1, $2, $3, $4, \'group_specific_critical_notices\', $5::jsonb)',
      [datasetKind, candidateId, traceId, reportRevisionId,
        JSON.stringify({ fixture: 'synthetic-test-only' })],
    );
    return { datasetKind, traceId, reportRevisionId, candidateId, evidence };
  }

  function makeContext(
    seed: Seed,
    suffix: string,
    overrides: Partial<GroundingContextRecord> = {},
  ): GroundingContextRecord {
    return {
      schema_version: '2.0', trace_id: seed.traceId, record_type: 'GroundingContext',
      dataset_kind: seed.datasetKind, context_id: 'context-' + suffix, candidate_id: seed.candidateId,
      evidence: [seed.evidence],
      revision_states: [{ report_revision_id: seed.reportRevisionId, revision_status: 'eligible' }],
      candidate_events: [], prior_decision_ids: [], missing_fields: ['service_status'], conflicts: [],
      retrieval_version: 'exact-v1', index_version: 'synthetic-index-v1', sufficient: false,
      ...overrides,
    };
  }

  async function seedEventAndDecision(
    seed: Seed,
    suffix: string,
  ): Promise<{ eventId: string; decisionId: string }> {
    const eventId = 'event-' + suffix;
    const decisionId = 'decision-' + suffix;
    const baseContext = makeContext(seed, 'decision-seed-' + suffix, {
      evidence: [], revision_states: [], missing_fields: [], sufficient: true,
    });
    await ports.groundingContexts.createOrVerify(baseContext);
    const proposalId = 'proposal-' + suffix;
    await database.executor.query(
      'INSERT INTO waspada.event_proposals ' +
        '(dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id, base_event_version, ' +
        'investigation_id, proposed_at, record_json) VALUES ($1, $2, $3, $4, $5, NULL, NULL, NULL, $6, $7::jsonb)',
      [seed.datasetKind, proposalId, seed.traceId, seed.candidateId, baseContext.context_id,
        TEST_TIME, JSON.stringify({ fixture: 'synthetic-test-only' })],
    );
    await database.executor.transaction(async (transaction) => {
      await transaction.query(
        'INSERT INTO waspada.publication_decisions ' +
          '(dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id, event_version, ' +
          'reviewer_id, decided_at, record_json) ' +
          'VALUES ($1, $2, $3, $4, \'synthetic-test-policy-v1\', $5, 1, NULL, $6, $7::jsonb)',
        [seed.datasetKind, decisionId, seed.traceId, proposalId, eventId, TEST_TIME,
          JSON.stringify({ fixture: 'synthetic-test-only' })],
      );
      await transaction.query(
        'INSERT INTO waspada.event_versions ' +
          '(dataset_kind, event_id, version, trace_id, supersedes_version, title, summary, category, lifecycle, ' +
          'publication_status, withdrawal_reason, publication_decision_id, published_at, withdrawn_at, record_json) ' +
          'VALUES ($1, $2, 1, $3, NULL, \'Synthetic test event\', \'Synthetic fixture only.\', ' +
          '\'group_specific_critical_notices\', \'unknown\', \'withdrawn\', \'other\', $4, NULL, $5, $6::jsonb)',
        [seed.datasetKind, eventId, seed.traceId, decisionId, TEST_TIME,
          JSON.stringify({ claims: [], impact_refs: [] })],
      );
    });
    return { eventId, decisionId };
  }

  async function insertRawContext(db: TestDatabase, record: GroundingContextRecord, retrievalVersion?: string): Promise<void> {
    await db.executor.query(
      'INSERT INTO waspada.grounding_contexts ' +
        '(dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version, sufficient, record_json) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)',
      [record.dataset_kind, record.context_id, record.trace_id, record.candidate_id,
        retrievalVersion ?? record.retrieval_version, record.index_version, record.sufficient, JSON.stringify(record)],
    );
  }

  async function assertValidationError(record: unknown): Promise<void> {
    await assert.rejects(
      ports.groundingContexts.createOrVerify(record as GroundingContextRecord),
      GroundingContextValidationError,
    );
  }

  async function assertConflict(record: GroundingContextRecord): Promise<void> {
    await assert.rejects(
      ports.groundingContexts.createOrVerify(record),
      (error: unknown) => {
        assert.ok(error instanceof GroundingContextConflictError);
        assert.equal(error.code, 'grounding_context_conflict');
        return true;
      },
    );
  }

  async function assertMissingEvidence(record: GroundingContextRecord): Promise<void> {
    await assert.rejects(
      ports.groundingContexts.createOrVerify(record),
      (error: unknown) => {
        assert.ok(error instanceof GroundingContextReferenceError);
        assert.equal(error.referenceKind, 'evidence');
        return true;
      },
    );
    const count = await database.executor.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waspada.grounding_contexts WHERE context_id = $1',
      [record.context_id],
    );
    assert.equal(count.rows[0]?.count, '0');
  }

  async function assertMissingReference(
    record: GroundingContextRecord,
    referenceKind: 'candidate_event' | 'prior_decision',
  ): Promise<void> {
    await assert.rejects(
      ports.groundingContexts.createOrVerify(record),
      (error: unknown) => {
        assert.ok(error instanceof GroundingContextReferenceError);
        assert.equal(error.referenceKind, referenceKind);
        return true;
      },
    );
    const count = await database.executor.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waspada.grounding_contexts WHERE context_id = $1',
      [record.context_id],
    );
    assert.equal(count.rows[0]?.count, '0');
  }

  async function evidenceCount(seed: Seed): Promise<string> {
    const result = await database.executor.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waspada.evidence_references ' +
        'WHERE dataset_kind = $1 AND report_revision_id = $2',
      [seed.datasetKind, seed.reportRevisionId],
    );
    return result.rows[0]!.count;
  }

  async function readEvidenceLinks(
    db: TestDatabase,
    record: GroundingContextRecord,
  ): Promise<readonly GroundingEvidenceReference[]> {
    const rows = await db.executor.query<GroundingEvidenceReference>(
      'SELECT evidence.report_revision_id, evidence.permitted_text_hash, evidence.span_start, ' +
        'evidence.span_end, evidence.offset_unit, evidence.relation ' +
        'FROM waspada.grounding_evidence AS link JOIN waspada.evidence_references AS evidence ' +
        'ON evidence.dataset_kind = link.dataset_kind AND evidence.evidence_ref_id = link.evidence_ref_id ' +
        'WHERE link.dataset_kind = $1 AND link.context_id = $2',
      [record.dataset_kind, record.context_id],
    );
    return rows.rows;
  }

  async function readEventDecisionLinks(
    db: TestDatabase,
    record: GroundingContextRecord,
  ): Promise<{ events: readonly { event_id: string; event_version: number }[]; decisions: readonly string[] }> {
    const events = await db.executor.query<{ event_id: string; event_version: number }>(
      'SELECT event_id, event_version FROM waspada.grounding_candidate_events ' +
        'WHERE dataset_kind = $1 AND context_id = $2 ORDER BY event_id, event_version',
      [record.dataset_kind, record.context_id],
    );
    const decisions = await db.executor.query<{ decision_id: string }>(
      'SELECT decision_id FROM waspada.grounding_prior_decisions ' +
        'WHERE dataset_kind = $1 AND context_id = $2 ORDER BY decision_id',
      [record.dataset_kind, record.context_id],
    );
    return { events: events.rows, decisions: decisions.rows.map((row) => row.decision_id) };
  }

  async function assertPermissionDenied(statement: string): Promise<void> {
    await assert.rejects(database.executor.query(statement), /permission denied/i);
  }

  async function assertMigrationReapplication(db: TestDatabase): Promise<void> {
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    const migration = migrations.find(({ version }) => version === '010_l2_grounding_context_writer');
    assert.ok(migration);
    const before = await writerSnapshot(db);
    await db.executor.transaction((transaction) => transaction.execute(migration.sql));
    assert.deepEqual(await writerSnapshot(db), before);
    await db.executor.transaction((transaction) => transaction.execute(migration.sql));
    assert.deepEqual(await writerSnapshot(db), before);
  }

  async function writerSnapshot(db: TestDatabase): Promise<unknown> {
    const role = await db.executor.query(
      'SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls ' +
        'FROM pg_roles WHERE rolname = \'waspada_l2_grounding_writer\'',
    );
    const grants = await db.executor.query(
      'SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges ' +
        'WHERE grantee = \'waspada_l2_grounding_writer\' AND table_schema = \'waspada\' ' +
        'ORDER BY table_name, column_name, privilege_type',
    );
    const schema = await db.executor.query(
      'SELECT has_schema_privilege(\'waspada_l2_grounding_writer\', \'waspada\', \'USAGE\') AS can_use, ' +
        'has_schema_privilege(\'waspada_l2_grounding_writer\', \'waspada\', \'CREATE\') AS can_create',
    );
    return { role: role.rows, grants: grants.rows, schema: schema.rows };
  }
});

interface Seed {
  readonly datasetKind: DatasetKind;
  readonly traceId: string;
  readonly reportRevisionId: string;
  readonly candidateId: string;
  readonly evidence: GroundingEvidenceReference;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
