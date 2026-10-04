import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  createSourceRevisionReviewCandidateReader,
  SourceRevisionReviewCandidateReaderError,
} from '../src/source-revision-review-candidate-reader.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import type { SqlExecutor } from '../src/sql.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const NOW = '2026-10-02T10:00:00.123456Z';
const OBSERVED_AT = '2026-10-01T01:02:03.123456Z';
const RETRIEVED_AT = '2026-10-02T04:05:06.654321+07:00';
const RECORDED_AT = '2026-10-03T05:06:07.111111+07:00';
const READER_ROLE = 'waspada_l4_report_revision_impact_reader';
const PRIVATE_SOURCE_TEXT = 'PRIVATE_SOURCE_TEXT authored fixture only.';
const PRIVATE_CLAIM_TEXT = 'PRIVATE_CLAIM_TEXT authored fixture only.';

type DatasetKind = 'synthetic' | 'historical';
type EvidenceKind = 'support' | 'contradiction';
interface EvidenceLinkFixture {
  readonly reference: string;
  readonly kind: EvidenceKind;
}
interface ClaimFixture {
  readonly id: string;
  readonly links: readonly EvidenceLinkFixture[];
}
interface ImpactFixture {
  readonly id: string;
  readonly version: number;
  readonly claims: readonly string[];
  readonly referenced?: boolean;
}
interface EventVersionFixture {
  readonly version: number;
  readonly status?: 'published' | 'withdrawn';
  readonly claims?: readonly ClaimFixture[];
  readonly impacts?: readonly ImpactFixture[];
}

let database!: TestDatabase;
let reader!: ReturnType<typeof createSourceRevisionReviewCandidateReader>;

describe('LIFE-01 source-revision review-candidate reader', () => {
  before(async () => {
    database = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(database.executor, migrations);
    await seedDataset('synthetic');
    await seedDataset('historical');
    reader = createSourceRevisionReviewCandidateReader(database.executor);
  });

  after(async () => database?.close());

  it('keeps each explicit invalidating assertion and exact current target independently', async () => {
    const page = await reader.read({ datasetKind: 'synthetic', limit: 100 });
    assert.equal(page.nextCursor, null);
    assert.equal(page.candidates.length, 11);
    assert.equal(page.candidates.every(({ datasetKind }) => datasetKind === 'synthetic'), true);
    assert.equal(page.candidates.every(({ assertedState }) =>
      ['superseded', 'retracted', 'withdrawn'].includes(assertedState)), true,
    'current-only and current assertions alongside conflicts do not create candidates');
    assert.equal(page.candidates.some(({ eventId }) => eventId === 'event-hidden'), false,
      'the latest withdrawn event version hides all older published versions');
    assert.equal(page.candidates.some(({ eventVersion }) => eventVersion === 1), false,
      'older published event versions are not review targets');

    const byObservation = groupBy(page.candidates, ({ observationId }) => observationId);
    assert.deepEqual([...byObservation.keys()], [
      'obs-a-superseded', 'obs-b-retracted', 'obs-c-withdrawn', 'obs-other-revision',
    ]);
    assert.deepEqual(
      ['obs-a-superseded', 'obs-b-retracted', 'obs-c-withdrawn'].map((id) =>
        byObservation.get(id)?.[0]?.assertedState),
      ['superseded', 'retracted', 'withdrawn'],
    );
    assert.deepEqual(byObservation.get('obs-current-only'), undefined,
      'a current-only observation creates no candidate even when its revision directly supports a claim');
    assert.deepEqual(byObservation.get('obs-current-conflict'), undefined,
      'the current assertion remains separate and does not mask the invalidating assertion');
    assert.equal(byObservation.get('obs-a-superseded')?.[0]?.replacementReportRevisionId,
      'revision-replacement');
    assert.equal(byObservation.get('obs-b-retracted')?.[0]?.replacementReportRevisionId, null);
    assert.equal(byObservation.get('obs-c-withdrawn')?.[0]?.replacementReportRevisionId, null);

    for (const observationId of ['obs-a-superseded', 'obs-b-retracted', 'obs-c-withdrawn']) {
      const candidates = byObservation.get(observationId) ?? [];
      assert.deepEqual(candidates.map(({ eventId, target }) => candidateTargetKey({ eventId, target })), [
        'event-alpha:event_claim_set',
        'event-alpha:impact:impact-target:1',
        'event-alpha:impact:impact-versioned:2',
      ]);
      assert.equal(candidates.every(({ targetReportRevisionId }) =>
        targetReportRevisionId === 'revision-target'), true);
      assert.equal(candidates.every(({ eventVersion }) => eventVersion === 2), true);
    }

    const otherRevision = byObservation.get('obs-other-revision') ?? [];
    assert.deepEqual(otherRevision.map(({ eventId, target }) => candidateTargetKey({ eventId, target })), [
      'event-alpha:event_claim_set', 'event-alpha:impact:impact-other:1',
    ]);
    assert.equal(otherRevision.every(({ targetReportRevisionId }) =>
      targetReportRevisionId === 'revision-other'), true,
    'each observation follows only evidence links to its exact target report revision');
    assert.equal(page.candidates.some(({ target }) =>
      target.kind === 'impact' && target.impactId === 'impact-versioned' && target.impactVersion === 1), false,
    'an impact version without an exact event-version reference is excluded');
    for (const excludedImpact of [
      'impact-contradiction', 'impact-context', 'impact-unreferenced',
    ]) {
      assert.equal(page.candidates.some(({ target }) =>
        target.kind === 'impact' && target.impactId === excludedImpact), false,
      'contradiction, context and absent exact impact references do not create impact targets');
    }

    const superseded = byObservation.get('obs-a-superseded')?.[0];
    assert.ok(superseded);
    assert.equal(superseded.publisherObservedAt, '2026-10-01T01:02:03.123456Z');
    assert.equal(superseded.retrievedAt, '2026-10-01T21:05:06.654321Z');
    assert.equal(superseded.recordedAt, '2026-10-02T22:06:07.111111Z');
    assert.equal(superseded.assertionReportRevisionId, 'revision-notice-a');

    for (const candidate of page.candidates) {
      assert.deepEqual(Object.keys(candidate).sort(), [
        'assertedState', 'assertionReportRevisionId', 'datasetKind', 'eventId', 'eventVersion',
        'observationId', 'publisherObservedAt', 'recordedAt', 'replacementReportRevisionId',
        'retrievedAt', 'target', 'targetReportRevisionId',
      ].sort());
      assert.deepEqual(Object.keys(candidate.target).sort(), candidate.target.kind === 'impact'
        ? ['impactId', 'impactVersion', 'kind'] : ['kind']);
    }
    const serialized = JSON.stringify(page);
    for (const privateValue of [
      PRIVATE_SOURCE_TEXT, PRIVATE_CLAIM_TEXT, 'https://private.invalid/',
      'canonical_url', 'traceId', 'sourceId', 'hash', 'permitted_text', 'record_json',
    ]) {
      assert.equal(serialized.includes(privateValue), false, `output omits ${privateValue}`);
    }
  });

  it('requires one explicit dataset and never joins same identifiers across namespaces', async () => {
    const synthetic = await reader.read({ datasetKind: 'synthetic', limit: 100 });
    const historical = await reader.read({ datasetKind: 'historical', limit: 100 });
    assert.equal(synthetic.candidates.some(({ datasetKind }) => datasetKind === 'historical'), false);
    assert.equal(historical.candidates.every(({ datasetKind }) => datasetKind === 'historical'), true);
    assert.equal(historical.candidates.length, 3);
    assert.deepEqual(historical.candidates.map(candidateTargetKey), [
      'obs-a-superseded:event-alpha:event_claim_set',
      'obs-a-superseded:event-alpha:impact:impact-target:1',
      'obs-a-superseded:event-alpha:impact:impact-versioned:2',
    ]);
    assert.equal(historical.candidates.every(({ assertedState }) => assertedState === 'withdrawn'), true,
      'the overlapping observation ID in historical data keeps its own assertion metadata');
  });

  it('pages in deterministic observation/event/target order with a limit-plus-one probe', async () => {
    const probeLimits: unknown[] = [];
    let calls = 0;
    const pagedReader = createSourceRevisionReviewCandidateReader({
      query: async <Row extends object>(statement: string, parameters: readonly unknown[] = []) => {
        calls += 1;
        assert.match(statement, /ORDER BY target\.observation_id COLLATE "C"/u);
        assert.match(statement, /LIMIT \$9::integer/u);
        probeLimits.push(parameters[8]);
        return database.executor.query<Row>(statement, parameters);
      },
    } as SqlExecutor);
    const request = { datasetKind: 'synthetic' as const, limit: 2 };
    const first = await pagedReader.read(request);
    assert.deepEqual(first.candidates.map(candidateTargetKey), [
      'obs-a-superseded:event-alpha:event_claim_set',
      'obs-a-superseded:event-alpha:impact:impact-target:1',
    ]);
    assert.deepEqual(first.nextCursor, {
      observationId: 'obs-a-superseded', eventId: 'event-alpha', eventVersion: 2,
      target: { kind: 'impact', impactId: 'impact-target', impactVersion: 1 },
    });
    const second = await pagedReader.read({ ...request, cursor: first.nextCursor });
    const allLaterKeys: string[] = [];
    let cursor = second.nextCursor;
    allLaterKeys.push(...second.candidates.map(candidateTargetKey));
    while (cursor !== null) {
      const next = await pagedReader.read({ ...request, cursor });
      allLaterKeys.push(...next.candidates.map(candidateTargetKey));
      cursor = next.nextCursor;
    }
    assert.equal(probeLimits.every((value) => value === 3), true);
    assert.equal(calls, 6);
    const allKeys = [...first.candidates].map(candidateTargetKey).concat(allLaterKeys);
    assert.equal(allKeys.length, 11);
    assert.equal(new Set(allKeys).size, 11, 'continuation has no duplicate candidates');
    assert.deepEqual(allKeys, [...allKeys].sort(compareCandidateKeys));
    assert.equal(allKeys.some((key) => key.includes('obs-current')), false);
  });

  it('rejects malformed requests before SQL and validates bounded ordered result rows', async () => {
    let calls = 0;
    const noQueryReader = createSourceRevisionReviewCandidateReader({
      query: async () => { calls += 1; return { rows: [] }; },
    } as unknown as SqlExecutor);
    for (const request of [
      { limit: 1 },
      { datasetKind: 'synthetic', limit: 0 },
      { datasetKind: 'synthetic', limit: 101 },
      { datasetKind: 'unknown', limit: 10 },
      { datasetKind: 'synthetic', limit: 1, extra: true },
      { datasetKind: 'synthetic', limit: 1, cursor: undefined },
      { datasetKind: 'synthetic', limit: 1, cursor: { eventId: 'event-alpha', eventVersion: 2, target: { kind: 'event_claim_set' } } },
      { datasetKind: 'synthetic', limit: 1, cursor: { observationId: 'obs-a', eventId: 'event-alpha', eventVersion: 0, target: { kind: 'event_claim_set' } } },
      { datasetKind: 'synthetic', limit: 1, cursor: { observationId: 'obs-a', eventId: 'event-alpha', eventVersion: 2, target: { kind: 'impact', impactId: 'impact-a', impactVersion: 1, extra: true } } },
    ]) {
      await expectReaderError(noQueryReader.read(request), 'INVALID_REQUEST');
    }
    assert.equal(calls, 0);

    const valid = rawCandidateRow();
    for (const rows of [
      [{ ...valid, source_url: 'https://private.invalid/secret' }],
      [valid, valid],
      [rawCandidateRow({ observationId: 'obs-z' }), rawCandidateRow({ observationId: 'obs-a' })],
      [rawCandidateRow({ retrievedAt: 'not-a-time' })],
      [rawCandidateRow({ assertedState: 'current' })],
      [rawCandidateRow({ assertedState: 'superseded', replacementReportRevisionId: null })],
      [rawCandidateRow({ targetKind: 'event_claim_set', impactId: 'impact-private', impactVersion: 1 })],
    ]) {
      const malformedReader = createSourceRevisionReviewCandidateReader({
        query: async () => ({ rows }),
      } as unknown as SqlExecutor);
      await expectReaderError(
        malformedReader.read({ datasetKind: 'synthetic', limit: 10 }), 'INVALID_RESULT',
      );
    }

    const tooManyReader = createSourceRevisionReviewCandidateReader({
      query: async () => ({ rows: [valid, rawCandidateRow({ observationId: 'obs-b' }), rawCandidateRow({ observationId: 'obs-c' })] }),
    } as unknown as SqlExecutor);
    await expectReaderError(tooManyReader.read({ datasetKind: 'synthetic', limit: 1 }), 'INVALID_RESULT');

    const cursorReader = createSourceRevisionReviewCandidateReader({
      query: async () => ({ rows: [valid] }),
    } as unknown as SqlExecutor);
    await expectReaderError(cursorReader.read({
      datasetKind: 'synthetic', limit: 1,
      cursor: { observationId: 'obs-a', eventId: 'event-a', eventVersion: 1, target: { kind: 'event_claim_set' } },
    }), 'INVALID_RESULT');

    const failingReader = createSourceRevisionReviewCandidateReader({
      query: async () => { throw new Error('private database diagnostic'); },
    } as unknown as SqlExecutor);
    await assert.rejects(failingReader.read({ datasetKind: 'synthetic', limit: 1 }),
      (error: unknown) => error instanceof SourceRevisionReviewCandidateReaderError
        && error.code === 'READ_FAILED'
        && error.message === 'The source-revision review-candidate page could not be read.'
        && !error.message.includes('private database diagnostic'));
  });

  it('reads under the intended role and denies source, claim, full-row, write, and unrelated access', async () => {
    const beforeState = await readSideEffectSnapshot();
    await database.executor.execute(`SET ROLE ${READER_ROLE}`);
    try {
      const role = await database.executor.query<{ current_user: string }>('SELECT current_user');
      assert.equal(role.rows[0]?.current_user, READER_ROLE);
      const page = await reader.read({ datasetKind: 'synthetic', limit: 100 });
      assert.equal(page.candidates.length, 11);

      for (const query of [
        'SELECT * FROM waspada.report_revision_source_observations',
        'SELECT source_id FROM waspada.report_revision_source_observations',
        'SELECT trace_id FROM waspada.report_revision_source_observations',
        'SELECT canonical_url FROM waspada.report_revisions',
        'SELECT permitted_text FROM waspada.report_revisions',
        'SELECT claim_text FROM waspada.event_claims',
        'SELECT record_json FROM waspada.event_versions',
        'SELECT * FROM waspada.publication_decisions',
        'SELECT * FROM waspada.source_registry',
      ]) {
        await assert.rejects(database.executor.query(query), (error) => error instanceof Error, query);
      }

      for (const statement of [
        "INSERT INTO waspada.report_revision_source_observations (dataset_kind, observation_id) VALUES ('synthetic', 'reader-write')",
        "UPDATE waspada.report_revision_source_observations SET asserted_state = 'withdrawn' WHERE dataset_kind = 'synthetic'",
        "DELETE FROM waspada.report_revision_source_observations WHERE dataset_kind = 'synthetic'",
        'TRUNCATE waspada.report_revision_source_observations',
        "UPDATE waspada.event_versions SET lifecycle = 'resolved' WHERE dataset_kind = 'synthetic'",
        'UPDATE waspada.impact_versions SET record_json = record_json WHERE dataset_kind = \'synthetic\'',
        'TRUNCATE waspada.geometries',
        'INSERT INTO waspada.freshness_transitions (dataset_kind) VALUES (\'synthetic\')',
        'INSERT INTO waspada.publication_decisions (dataset_kind) VALUES (\'synthetic\')',
      ]) {
        await assert.rejects(database.executor.query(statement), (error) => error instanceof Error, statement);
      }
    } finally {
      await database.executor.execute('RESET ROLE');
    }
    assert.deepEqual(await readSideEffectSnapshot(), beforeState,
      'the read and denied mutations preserve observations, publication/history, lifecycle, freshness, geometry, audit and outbox data');
  });
});

async function seedDataset(datasetKind: DatasetKind): Promise<void> {
  const traceId = `trace-review-${datasetKind}`;
  const sourceId = `source-review-${datasetKind}`;
  await database.executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, $2, $3, 'open', '{"fixture":"synthetic-only"}'::jsonb)`,
    [traceId, datasetKind, NOW],
  );
  await database.executor.query(
    `INSERT INTO waspada.source_registry
       (source_id, trace_id, registry_version, display_name, source_kind, remit, access_method,
        approved_hosts, access_restrictions, reuse_basis, registry_status, approval_status,
        health_status, auto_acquisition_enabled, auto_publication_policy)
     VALUES ($1, $2, 1, 'Authored review fixture', 'other', ARRAY['test'], 'manual_fixture',
             ARRAY[]::text[], ARRAY['synthetic only'], ARRAY['authored fixture'],
             'active', 'approved', 'unknown', false, 'never')`,
    [sourceId, traceId],
  );

  const revisionIds = [
    'revision-target', 'revision-current-only', 'revision-other', 'revision-notice-a',
    'revision-notice-b', 'revision-notice-c', 'revision-notice-current',
    'revision-notice-other', 'revision-replacement',
  ];
  for (const revisionId of revisionIds) {
    const supersedesId = revisionId === 'revision-replacement' ? 'revision-target' : null;
    const text = `${PRIVATE_SOURCE_TEXT} ${datasetKind} ${revisionId}`;
    await database.executor.query(
      `INSERT INTO waspada.report_revisions
         (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash,
          permitted_text, permitted_text_hash, normalization_version, retrieved_at,
          supersedes_id, revision_status, record_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'fixture-normalization-v1', $9,
               $10, 'eligible', '{"fixture":"synthetic-only"}'::jsonb)`,
      [datasetKind, revisionId, traceId, sourceId, `https://private.invalid/${revisionId}`,
        hash(`content ${datasetKind} ${revisionId}`), text, hash(text), NOW, supersedesId],
    );
  }

  const evidenceReferences: Record<string, number> = {};
  const referenceFixtures = [
    { name: 'target-support', revisionId: 'revision-target', relation: 'supports' },
    { name: 'target-contradiction', revisionId: 'revision-target', relation: 'contradicts' },
    { name: 'target-context', revisionId: 'revision-target', relation: 'context' },
    { name: 'other-support', revisionId: 'revision-other', relation: 'supports' },
    { name: 'current-only-support', revisionId: 'revision-current-only', relation: 'supports' },
  ] as const;
  for (const [index, fixture] of referenceFixtures.entries()) {
    const text = `${PRIVATE_SOURCE_TEXT} ${datasetKind} ${fixture.revisionId}`;
    const result = await database.executor.query<{ evidence_ref_id: string }>(
      `INSERT INTO waspada.evidence_references
         (dataset_kind, trace_id, report_revision_id, permitted_text_hash, span_start, span_end,
          offset_unit, relation)
       VALUES ($1, $2, $3, $4, $6, $7, 'unicode_code_points', $5)
       RETURNING evidence_ref_id::text AS evidence_ref_id`,
      [datasetKind, traceId, fixture.revisionId, hash(text), fixture.relation, index, index + 1],
    );
    evidenceReferences[fixture.name] = Number(result.rows[0]?.evidence_ref_id);
  }

  const candidateId = `candidate-review-${datasetKind}`;
  const contextId = `context-review-${datasetKind}`;
  const proposalId = `proposal-review-${datasetKind}`;
  await database.executor.query(
    `INSERT INTO waspada.extraction_results
       (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
     VALUES ($1, $2, $3, 'revision-target', NULL, '{"fixture":"synthetic-only"}'::jsonb)`,
    [datasetKind, candidateId, traceId],
  );
  await database.executor.query(
    `INSERT INTO waspada.grounding_contexts
       (dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version, sufficient, record_json)
     VALUES ($1, $2, $3, $4, 'fixture-retrieval-v1', 'fixture-index-v1', false,
             '{"fixture":"synthetic-only"}'::jsonb)`,
    [datasetKind, contextId, traceId, candidateId],
  );
  await database.executor.query(
    `INSERT INTO waspada.event_proposals
       (dataset_kind, proposal_id, trace_id, candidate_id, context_id, proposed_at, record_json)
     VALUES ($1, $2, $3, $4, $5, $6, '{"fixture":"synthetic-only"}'::jsonb)`,
    [datasetKind, proposalId, traceId, candidateId, contextId, NOW],
  );

  const noticeIds = datasetKind === 'synthetic'
    ? [
      { observationId: 'obs-a-superseded', target: 'revision-target', assertion: 'revision-notice-a', state: 'superseded', replacement: 'revision-replacement' },
      { observationId: 'obs-b-retracted', target: 'revision-target', assertion: 'revision-notice-b', state: 'retracted', replacement: null },
      { observationId: 'obs-c-withdrawn', target: 'revision-target', assertion: 'revision-notice-c', state: 'withdrawn', replacement: null },
      { observationId: 'obs-current-conflict', target: 'revision-target', assertion: 'revision-notice-current', state: 'current', replacement: null },
      { observationId: 'obs-current-only', target: 'revision-current-only', assertion: 'revision-notice-current', state: 'current', replacement: null },
      { observationId: 'obs-other-revision', target: 'revision-other', assertion: 'revision-notice-other', state: 'retracted', replacement: null },
    ] as const
    : [
      { observationId: 'obs-a-superseded', target: 'revision-target', assertion: 'revision-notice-c', state: 'withdrawn', replacement: null },
    ] as const;
  for (const observation of noticeIds) {
    await database.executor.query(
      `INSERT INTO waspada.report_revision_source_observations
         (dataset_kind, observation_id, trace_id, source_id, target_report_revision_id,
          assertion_report_revision_id, asserted_state, replacement_report_revision_id,
          publisher_observed_at, retrieved_at, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11::timestamptz)`,
      [datasetKind, observation.observationId, traceId, sourceId, observation.target,
        observation.assertion, observation.state, observation.replacement, OBSERVED_AT,
        RETRIEVED_AT, RECORDED_AT],
    );
  }

  await seedEvent(datasetKind, proposalId, traceId, evidenceReferences, 'event-alpha', [
    {
      version: 1,
      claims: [{ id: 'claim-alpha-old', links: [{ reference: 'target-support', kind: 'support' }] }],
    },
    {
      version: 2,
      claims: [
        { id: 'claim-target', links: [{ reference: 'target-support', kind: 'support' }] },
        { id: 'claim-contradiction', links: [{ reference: 'target-contradiction', kind: 'support' }] },
        { id: 'claim-context', links: [{ reference: 'target-context', kind: 'support' }] },
        { id: 'claim-wrong-kind', links: [{ reference: 'target-support', kind: 'contradiction' }] },
        { id: 'claim-other-revision', links: [{ reference: 'other-support', kind: 'support' }] },
        { id: 'claim-current-only', links: [{ reference: 'current-only-support', kind: 'support' }] },
      ],
      impacts: [
        { id: 'impact-target', version: 1, claims: ['claim-target'] },
        { id: 'impact-versioned', version: 1, claims: ['claim-target'], referenced: false },
        { id: 'impact-versioned', version: 2, claims: ['claim-target'] },
        { id: 'impact-contradiction', version: 1, claims: ['claim-contradiction'] },
        { id: 'impact-context', version: 1, claims: ['claim-context'] },
        { id: 'impact-other', version: 1, claims: ['claim-other-revision'] },
        { id: 'impact-unreferenced', version: 1, claims: ['claim-target'], referenced: false },
      ],
    },
  ]);
  await seedEvent(datasetKind, proposalId, traceId, evidenceReferences, 'event-hidden', [
    {
      version: 1,
      claims: [{ id: 'claim-hidden-old', links: [{ reference: 'target-support', kind: 'support' }] }],
    },
    { version: 2, status: 'withdrawn' },
  ]);
}

async function seedEvent(
  datasetKind: DatasetKind,
  proposalId: string,
  traceId: string,
  evidenceReferences: Readonly<Record<string, number>>,
  eventId: string,
  versions: readonly EventVersionFixture[],
): Promise<void> {
  for (const fixture of versions) {
    const status = fixture.status ?? 'published';
    const claims = fixture.claims ?? [];
    const impacts = fixture.impacts ?? [];
    const decisionId = `decision-${datasetKind}-${eventId}-${fixture.version}`;
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
      claims: status === 'published'
        ? claims.map(({ id }) => ({ claim_id: id, text: PRIVATE_CLAIM_TEXT })) : [],
      impact_refs: status === 'published'
        ? impacts.filter(({ referenced }) => referenced !== false)
          .map(({ id, version }) => ({ impact_id: id, version })) : [],
      publication_status: status,
      withdrawal_reason: status === 'withdrawn' ? 'other' : null,
      publication_decision_id: decisionId,
      published_at: status === 'published' ? NOW : null,
      withdrawn_at: status === 'withdrawn' ? NOW : null,
    };
    await database.executor.transaction(async (transaction) => {
      await transaction.execute('SET CONSTRAINTS ALL DEFERRED');
      await transaction.query(
        `INSERT INTO waspada.publication_decisions
           (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id,
            event_version, decided_at, record_json)
         VALUES ($1, $2, $3, $4, 'fixture-policy-v1', $5, $6, $7,
                 '{"fixture":"synthetic-only"}'::jsonb)`,
        [datasetKind, decisionId, traceId, proposalId, eventId, fixture.version, NOW],
      );
      await transaction.query(
        `INSERT INTO waspada.event_versions
           (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary,
            category, lifecycle, publication_status, withdrawal_reason, publication_decision_id,
            published_at, withdrawn_at, record_json)
         VALUES ($1, $2, $3, $4, $5, 'Authored synthetic event title.',
                 'Authored synthetic event summary.', 'transport_road_incidents', 'unknown',
                 $6, $7, $8, $9, $10, $11::jsonb)`,
        [datasetKind, eventId, fixture.version, traceId,
          fixture.version === 1 ? null : fixture.version - 1, status,
          status === 'withdrawn' ? 'other' : null, decisionId,
          status === 'published' ? NOW : null, status === 'withdrawn' ? NOW : null,
          JSON.stringify(record)],
      );
      if (status !== 'published') return;

      for (const claim of claims) {
        await transaction.query(
          `INSERT INTO waspada.event_claims
             (dataset_kind, event_id, event_version, claim_id, claim_text, evidence_label, record_json)
           VALUES ($1, $2, $3, $4, $5, 'issuer_notice', $6::jsonb)`,
          [datasetKind, eventId, fixture.version, claim.id, PRIVATE_CLAIM_TEXT,
            JSON.stringify({ claim_id: claim.id, text: PRIVATE_CLAIM_TEXT })],
        );
        for (const link of claim.links) {
          await transaction.query(
            `INSERT INTO waspada.event_claim_evidence
               (dataset_kind, event_id, event_version, claim_id, evidence_kind, evidence_ref_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [datasetKind, eventId, fixture.version, claim.id, link.kind,
              evidenceReferences[link.reference]],
          );
        }
      }
      for (const impact of impacts) {
        await transaction.query(
          `INSERT INTO waspada.impact_versions
             (dataset_kind, impact_id, version, trace_id, event_id, event_version,
              impact_type, lifecycle, published_at, record_json)
           VALUES ($1, $2, $3, $4, $5, $6, 'road_closure', 'unknown', $7,
                   '{"fixture":"private synthetic impact"}'::jsonb)`,
          [datasetKind, impact.id, impact.version, traceId, eventId, fixture.version, NOW],
        );
        if (impact.referenced !== false) {
          await transaction.query(
            `INSERT INTO waspada.event_impact_refs
               (dataset_kind, event_id, event_version, impact_id, impact_version)
             VALUES ($1, $2, $3, $4, $5)`,
            [datasetKind, eventId, fixture.version, impact.id, impact.version],
          );
        }
        for (const claimId of impact.claims) {
          await transaction.query(
            `INSERT INTO waspada.impact_claim_support
               (dataset_kind, impact_id, impact_version, event_id, event_version, claim_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [datasetKind, impact.id, impact.version, eventId, fixture.version, claimId],
          );
        }
      }
    });
  }
}

async function readSideEffectSnapshot(): Promise<Record<string, unknown>> {
  const result = await database.executor.query<Record<string, unknown>>(
    `SELECT
       (SELECT string_agg(dataset_kind || ':' || observation_id || ':' || asserted_state
                            || ':' || target_report_revision_id, ',' ORDER BY dataset_kind, observation_id)
        FROM waspada.report_revision_source_observations) AS observations,
       (SELECT string_agg(dataset_kind || ':' || event_id || ':' || version || ':'
                            || publication_status || ':' || lifecycle || ':' || record_json::text,
                          ',' ORDER BY dataset_kind, event_id, version)
        FROM waspada.event_versions) AS event_versions,
       (SELECT string_agg(dataset_kind || ':' || event_id || ':' || event_version || ':' || claim_id,
                          ',' ORDER BY dataset_kind, event_id, event_version, claim_id)
        FROM waspada.event_claims) AS event_claims,
       (SELECT string_agg(dataset_kind || ':' || impact_id || ':' || version || ':' || record_json::text,
                          ',' ORDER BY dataset_kind, impact_id, version)
        FROM waspada.impact_versions) AS impact_versions,
       (SELECT count(*)::text FROM waspada.geometries) AS geometries,
       (SELECT count(*)::text FROM waspada.freshness_transitions) AS freshness_transitions,
       (SELECT count(*)::text FROM waspada.freshness_transition_evidence) AS freshness_evidence,
       (SELECT count(*)::text FROM waspada.publication_decisions) AS publication_decisions,
       (SELECT count(*)::text FROM waspada.audit_records) AS audit_records,
       (SELECT count(*)::text FROM waspada.publication_outbox) AS publication_outbox,
       (SELECT count(*)::text FROM waspada.publication_outbox_delivery_attempts) AS delivery_attempts,
       (SELECT count(*)::text FROM waspada.publication_outbox_delivery_results) AS delivery_results`,
  );
  assert.ok(result.rows[0]);
  return result.rows[0];
}

function groupBy<T, Key extends string>(values: readonly T[], keyOf: (value: T) => Key): Map<Key, T[]> {
  const groups = new Map<Key, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

function candidateTargetKey(candidate: {
  readonly observationId?: string;
  readonly eventId: string;
  readonly target: { readonly kind: string; readonly impactId?: string; readonly impactVersion?: number };
}): string {
  const prefix = candidate.observationId === undefined ? '' : `${candidate.observationId}:`;
  return candidate.target.kind === 'impact'
    ? `${prefix}${candidate.eventId}:impact:${candidate.target.impactId}:${candidate.target.impactVersion}`
    : `${prefix}${candidate.eventId}:event_claim_set`;
}

function compareCandidateKeys(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function rawCandidateRow(overrides: {
  readonly observationId?: string;
  readonly assertedState?: string;
  readonly replacementReportRevisionId?: string | null;
  readonly retrievedAt?: string;
  readonly targetKind?: string;
  readonly impactId?: string | null;
  readonly impactVersion?: number | null;
} = {}): Record<string, unknown> {
  return {
    dataset_kind: 'synthetic',
    observation_id: overrides.observationId ?? 'obs-a',
    asserted_state: overrides.assertedState ?? 'retracted',
    target_report_revision_id: 'revision-target',
    assertion_report_revision_id: 'revision-notice',
    replacement_report_revision_id: overrides.replacementReportRevisionId ?? null,
    publisher_observed_at: '2026-10-01T01:02:03.123456Z',
    retrieved_at: overrides.retrievedAt ?? '2026-10-01T21:05:06.654321Z',
    recorded_at: '2026-10-02T22:06:07.111111Z',
    event_id: 'event-a',
    event_version: 1,
    target_kind: overrides.targetKind ?? 'event_claim_set',
    impact_id: overrides.impactId ?? null,
    impact_version: overrides.impactVersion ?? null,
  };
}

async function expectReaderError(
  operation: Promise<unknown>,
  code: 'INVALID_REQUEST' | 'INVALID_RESULT' | 'READ_FAILED',
): Promise<void> {
  await assert.rejects(operation, (error: unknown) =>
    error instanceof SourceRevisionReviewCandidateReaderError && error.code === code);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
