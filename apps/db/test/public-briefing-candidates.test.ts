import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createPublicBriefingCandidateRepository, PublicBriefingCandidateError } from '../src/public-briefing-candidates.js';
import type { SqlExecutor } from '../src/sql.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const FIRST = '2026-09-26T10:00:00.000000Z';
const SECOND = '2026-09-26T11:00:00.000000Z';
const OLDER = '2026-09-26T09:00:00.000000Z';
const WITHDRAWN_AT = '2026-09-26T12:00:00.000000Z';
type DatasetKind = 'live' | 'synthetic' | 'historical';
type EntityType = 'place' | 'service' | 'institution' | 'audience';
interface Fixture {
  datasetKind: DatasetKind; prefix: string; traceId: string; sourceId: string;
  revisionId: string; candidateId: string; contextId: string;
}
interface ScopeIds {
  place_ids?: readonly string[]; service_ids?: readonly string[];
  institution_ids?: readonly string[]; audience_ids?: readonly string[];
}
interface EventOptions {
  category?: string; recordCategory?: string; scope?: ScopeIds; claimScopes?: readonly ScopeIds[];
}
interface Interests {
  places: readonly unknown[]; services: readonly unknown[];
  institutions: readonly unknown[]; audiences: readonly unknown[];
  categories: readonly unknown[];
}
let database: TestDatabase;
let live: Fixture;
let synthetic: Fixture;
let historical: Fixture;

describe('public briefing candidate repository', () => {
  before(async () => {
    database = await createTestDatabase();
    await applyMigrations(database.executor, await readMigrations(new URL('../migrations/', import.meta.url)));
    await database.executor.query(
      "INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')",
    );
    live = await seedFixture('live', 'briefing-live');
    synthetic = await seedFixture('synthetic', 'briefing-synthetic');
    historical = await seedFixture('historical', 'briefing-historical');
    const names: readonly [EntityType, string, string, string?][] = [
      ['place', 'p-event', 'Place Event'], ['service', 's-event', 'Service Event'],
      ['institution', 'i-event', 'Institution Event'], ['audience', 'a-event', 'Audience Event'],
      ['place', 'p-claim', 'Place Claim'], ['service', 's-claim', 'Service Claim'],
      ['institution', 'i-claim', 'Institution Claim'], ['audience', 'a-claim', 'Audience Claim'],
      ['place', 'p-impact', 'Place Impact'], ['service', 's-impact', 'Service Impact'],
      ['institution', 'i-impact', 'Institution Impact'], ['audience', 'a-impact', 'Audience Impact'],
      ['place', 'p-duplicate', 'Same Scope'], ['place', 'p-order-new', 'Order New'],
      ['place', 'p-order-old', 'Order Old'], ['place', 'p-substring', 'Area Contoh Lanjutan'],
      ['place', 'p-unicode', '\u00a0Cafe\u0301 Contoh\u3000'], ['place', 'p-dotted-i', 'İstanbul'],
      ['place', 'p-greek', 'ΟΣ'], ['place', 'p-held', 'Held Scope'],
      ['place', 'p-english', 'English Scope', 'en-US'], ['place', 'p-versioned', 'Old Event Scope'],
      ['place', 'p-stale-impact', 'Old Impact Scope'], ['place', 'p-withdrawn', 'Withdrawn Scope'],
    ];
    for (const [type, id, name, locale] of names) await seedScopeName(type, id, 1, 'approved', name, locale);
    await seedScopeName('place', 'p-held', 2, 'held', null);

    for (const [eventId, type, id] of [
      ['event-place', 'place', 'p-event'], ['event-service', 'service', 's-event'],
      ['event-institution', 'institution', 'i-event'], ['event-audience', 'audience', 'a-event'],
    ] as const) await seedEvent(live, eventId, 1, 'published', FIRST, { scope: scopeFor(type, id) });
    for (const [eventId, type, id] of [
      ['claim-place', 'place', 'p-claim'], ['claim-service', 'service', 's-claim'],
      ['claim-institution', 'institution', 'i-claim'], ['claim-audience', 'audience', 'a-claim'],
    ] as const) await seedEvent(live, eventId, 1, 'published', FIRST, { claimScopes: [scopeFor(type, id)] });
    for (const [eventId, type, id] of [
      ['impact-place', 'place', 'p-impact'], ['impact-service', 'service', 's-impact'],
      ['impact-institution', 'institution', 'i-impact'], ['impact-audience', 'audience', 'a-impact'],
    ] as const) {
      await seedEvent(live, eventId, 1, 'published', FIRST);
      await seedImpact(live, eventId, 1, 'impact-' + eventId, 1, scopeFor(type, id));
    }
    await seedEvent(live, 'event-duplicate', 1, 'published', FIRST, {
      scope: { place_ids: ['p-duplicate'] }, claimScopes: [{ place_ids: ['p-duplicate'] }],
    });
    await seedImpact(live, 'event-duplicate', 1, 'impact-duplicate', 1, { place_ids: ['p-duplicate'] });
    await seedEvent(live, 'event-substring', 1, 'published', FIRST, { scope: { place_ids: ['p-substring'] } });
    await seedEvent(live, 'event-unicode', 1, 'published', FIRST, { scope: { place_ids: ['p-unicode'] } });
    await seedEvent(live, 'event-dotted-i', 1, 'published', FIRST, { scope: { place_ids: ['p-dotted-i'] } });
    await seedEvent(live, 'event-greek', 1, 'published', FIRST, { scope: { place_ids: ['p-greek'] } });
    await seedEvent(live, 'event-held', 1, 'published', FIRST, { scope: { place_ids: ['p-held'] } });
    await seedEvent(live, 'event-english', 1, 'published', FIRST, { scope: { place_ids: ['p-english'] } });
    await seedEvent(live, 'event-versioned', 1, 'published', FIRST, {
      category: 'utilities_essential_services', scope: { place_ids: ['p-versioned'] },
    });
    await seedEvent(live, 'event-versioned', 2, 'published', SECOND, { category: 'utilities_essential_services' });
    await seedEvent(live, 'event-stale-impact', 1, 'published', FIRST);
    await seedImpact(live, 'event-stale-impact', 1, 'impact-stale', 1, { place_ids: ['p-stale-impact'] });
    await seedEvent(live, 'event-stale-impact', 2, 'published', SECOND);
    await seedEvent(live, 'event-withdrawn', 1, 'published', FIRST, { scope: { place_ids: ['p-withdrawn'] } });
    await seedEvent(live, 'event-withdrawn', 2, 'withdrawn', null);
    await seedEvent(synthetic, 'event-synthetic', 1, 'published', FIRST, { scope: { place_ids: ['p-event'] } });
    await seedEvent(historical, 'event-historical', 1, 'published', FIRST, { scope: { place_ids: ['p-event'] } });
    await seedEvent(live, 'event-category', 1, 'published', FIRST, { category: 'crime_personal_security' });
    await seedEvent(live, 'event-category-case-mismatch', 1, 'published', FIRST, {
      recordCategory: 'CRIME_PERSONAL_SECURITY',
    });
    await seedEvent(live, 'event-order-new', 1, 'published', SECOND, { scope: { place_ids: ['p-order-new'] } });
    await seedEvent(live, 'event-order-old', 1, 'published', OLDER, { scope: { place_ids: ['p-order-old'] } });
  });

  after(async () => { await database?.close(); });

  it('matches every scope dimension in event, claim, and current linked-impact scopes', async () => {
    const repo = createPublicBriefingCandidateRepository(database.executor);
    const cases: readonly [keyof Interests, string, string][] = [
      ['places', 'Place Event', 'event-place'], ['services', 'Service Event', 'event-service'],
      ['institutions', 'Institution Event', 'event-institution'], ['audiences', 'Audience Event', 'event-audience'],
      ['places', 'Place Claim', 'claim-place'], ['services', 'Service Claim', 'claim-service'],
      ['institutions', 'Institution Claim', 'claim-institution'], ['audiences', 'Audience Claim', 'claim-audience'],
      ['places', 'Place Impact', 'impact-place'], ['services', 'Service Impact', 'impact-service'],
      ['institutions', 'Institution Impact', 'impact-institution'], ['audiences', 'Audience Impact', 'impact-audience'],
    ];
    for (const [field, name, expected] of cases) {
      assert.deepEqual((await repo.read(request({ [field]: [name] }))).map((row) => row.eventId), [expected]);
    }
  });

  it('uses exact category and normalized exact names, deduplicates, and orders after matching', async () => {
    const repo = createPublicBriefingCandidateRepository(database.executor);
    const result = await repo.read(request({
      categories: ['crime_personal_security'], places: ['Place Event', 'Same Scope'],
    }));
    assert.deepEqual(result.map((row) => row.eventId), ['event-category', 'event-duplicate', 'event-place']);
    assert.deepEqual(result.map((row) => row.firstPublishedAt), [FIRST, FIRST, FIRST]);
    const timed = await repo.read(request({ places: ['Order Old', 'Order New'] }));
    assert.deepEqual(timed.map((row) => row.eventId), ['event-order-new', 'event-order-old']);
    assert.deepEqual(timed.map((row) => row.firstPublishedAt), [SECOND, OLDER]);
    assert.deepEqual((await repo.read(request({ places: ['Area Contoh'] }))).map((row) => row.eventId), []);
    assert.deepEqual((await repo.read(request({ places: ['Café Contoh'] }))).map((row) => row.eventId), ['event-unicode']);
    assert.deepEqual((await repo.read(request({ places: ['i\u0307stanbul'] }))).map((row) => row.eventId), ['event-dotted-i']);
    assert.deepEqual((await repo.read(request({ places: ['ος'] }))).map((row) => row.eventId), ['event-greek']);
  });

  it('uses the immutable version-1 timestamp and only current published live scope data', async () => {
    const repo = createPublicBriefingCandidateRepository(database.executor);
    assert.deepEqual(await repo.read(request({ categories: ['utilities_essential_services'] })), [{
      eventId: 'event-versioned', eventVersion: 2, firstPublishedAt: FIRST,
    }]);
    for (const name of ['Old Event Scope', 'Old Impact Scope', 'Held Scope', 'English Scope', 'Withdrawn Scope']) {
      assert.deepEqual((await repo.read(request({ places: [name] }))).map((row) => row.eventId), [], name);
    }
    assert.deepEqual(
      (await repo.read(request({ places: ['Place Event'] }))).map((row) => row.eventId),
      ['event-place'],
      'synthetic and historical candidates are excluded',
    );
  });

  it('uses only the approved public views under the reader role', async () => {
    const grants = await database.executor.query<{
      current_view: boolean; history_view: boolean; impacts_view: boolean;
      scope_view: boolean; private_base_table: boolean;
    }>(
      'SELECT has_table_privilege(\'waspada_public_reader\', \'waspada.public_event_versions\', \'SELECT\') AS current_view, ' +
      'has_table_privilege(\'waspada_public_reader\', \'waspada.public_event_history_versions\', \'SELECT\') AS history_view, ' +
      'has_table_privilege(\'waspada_public_reader\', \'waspada.public_event_impacts\', \'SELECT\') AS impacts_view, ' +
      'has_table_privilege(\'waspada_public_reader\', \'waspada.public_scope_names\', \'SELECT\') AS scope_view, ' +
      'has_table_privilege(\'waspada_public_reader\', \'waspada.event_versions\', \'SELECT\') AS private_base_table',
    );
    assert.deepEqual(grants.rows[0], {
      current_view: true, history_view: true, impacts_view: true, scope_view: true, private_base_table: false,
    });
    const calls: { statement: string; parameters: readonly unknown[] }[] = [];
    const repo = createPublicBriefingCandidateRepository(recordQueries(database.executor, calls));
    await database.executor.execute('SET ROLE waspada_public_reader');
    try {
      assert.deepEqual((await repo.read(request({ categories: ['crime_personal_security'] }))).map((row) => row.eventId), ['event-category']);
      await assert.rejects(database.executor.query('SELECT event_id FROM waspada.event_versions LIMIT 1'), /permission denied/iu);
    } finally {
      await database.executor.execute('RESET ROLE');
    }
    const call = calls[0]!;
    assert.deepEqual(call.parameters.slice(0, 5), [[], [], [], [], ['crime_personal_security']]);
    assert.equal(call.parameters[5], 101);
    assert.match(call.statement, /LIMIT \$6/u);
    assert.match(call.statement, /waspada\.public_scope_names/u);
    assert.match(call.statement, /waspada\.public_event_impacts/u);
    assert.doesNotMatch(call.statement, /(?:FROM|JOIN) waspada\.(?:event_versions|event_impact_refs|scope_name_review_decisions|publication_decisions)/iu);
  });

  it('returns all 100 results and rejects the 101st without partial candidates', async () => {
    const repo = createPublicBriefingCandidateRepository(database.executor);
    for (let index = 1; index <= 100; index += 1) {
      await seedEvent(live, 'overflow-' + String(index).padStart(3, '0'), 1, 'published', OLDER, {
        category: 'violence_immediate_threats',
      });
    }
    const input = request({ categories: ['violence_immediate_threats'] });
    const firstHundred = await repo.read(input);
    assert.equal(firstHundred.length, 100);
    assert.deepEqual([firstHundred[0]?.eventId, firstHundred[99]?.eventId], ['overflow-001', 'overflow-100']);
    await seedEvent(live, 'overflow-101', 1, 'published', OLDER, { category: 'violence_immediate_threats' });
    await assert.rejects(repo.read(input), (error: unknown) =>
      error instanceof PublicBriefingCandidateError && error.code === 'RESULT_LIMIT_EXCEEDED'
      && error.message === 'The briefing exceeds its maximum number of items.');
  });

  it('avoids SQL for empty normalized interests and validates malformed requests before reading', async () => {
    let count = 0;
    const repo = createPublicBriefingCandidateRepository(fakeExecutor(() => { count += 1; return []; }));
    assert.deepEqual(await repo.read(request({ places: [' \u00a0\ufeff '], services: ['\t\n'] })), []);
    assert.deepEqual(await repo.read(request({ places: ['\u0000'] })), []);
    for (const invalid of [
      null, {}, { interests: { ...emptyInterests(), extra: true } },
      request({ places: Array(31).fill('x') }), request({ places: ['x'.repeat(129)] }),
      request({ categories: ['crime_personal_security', 'crime_personal_security'] }),
      request({ categories: ['not-a-category'] }), request({ places: [42] }),
      ({ interests: { ...emptyInterests(), places: ['x'] }, extra: true } as unknown),
    ]) {
      await assert.rejects(repo.read(invalid), (error: unknown) =>
        error instanceof PublicBriefingCandidateError && error.code === 'INVALID_REQUEST');
    }
    assert.equal(count, 0);
  });

  it('parameterizes interests and redacts database failures and invalid rows', async () => {
    const privateInterest = 'fictional-interest-secret';
    let statement = '';
    let parameters: readonly unknown[] = [];
    await createPublicBriefingCandidateRepository(fakeExecutor((sql, args) => {
      statement = sql ?? ''; parameters = args ?? []; return [];
    })).read(request({ places: [privateInterest] }));
    assert.ok(!statement.includes(privateInterest));
    assert.ok(JSON.stringify(parameters).includes(privateInterest));

    const secret = 'fictional-database-error-secret';
    await assert.rejects(
      createPublicBriefingCandidateRepository(fakeExecutor(() => { throw new Error(secret + ' private SQL'); }))
        .read(request({ places: [secret] })),
      (error: unknown) => error instanceof PublicBriefingCandidateError && error.code === 'READ_FAILED'
        && !error.message.includes(secret) && !error.message.includes('SQL'),
    );
    const valid = { dataset_kind: 'live', event_id: 'event-valid', version: 1, first_published_at: FIRST };
    const invalidRows: readonly unknown[][] = [
      [{ ...valid, private_event_label: secret }], [{ ...valid, dataset_kind: 'synthetic' }],
      [{ ...valid, event_id: 'bad/id' }], [{ ...valid, version: 0 }],
      [{ ...valid, first_published_at: '2026-02-30T10:00:00.000000Z' }],
      [valid, { ...valid, event_id: 'event-other', first_published_at: SECOND }],
      [valid, valid],
      Array.from({ length: 102 }, (_, index) => ({ ...valid, event_id: 'event-' + String(index).padStart(3, '0') })),
    ];
    for (const rows of invalidRows) {
      await assert.rejects(
        createPublicBriefingCandidateRepository(fakeExecutor(() => rows))
          .read(request({ categories: ['crime_personal_security'] })),
        (error: unknown) => error instanceof PublicBriefingCandidateError && error.code === 'RESULT_INVALID'
          && !error.message.includes(secret),
      );
    }
  });
});

function emptyInterests(): Interests {
  return { places: [], services: [], institutions: [], audiences: [], categories: [] };
}
function request(overrides: Partial<Interests> = {}): unknown {
  return { interests: { ...emptyInterests(), ...overrides } };
}
function scopeFor(type: EntityType, id: string): ScopeIds {
  if (type === 'place') return { place_ids: [id] };
  if (type === 'service') return { service_ids: [id] };
  if (type === 'institution') return { institution_ids: [id] };
  return { audience_ids: [id] };
}
async function seedFixture(datasetKind: DatasetKind, prefix: string): Promise<Fixture> {
  const f: Fixture = {
    datasetKind, prefix, traceId: prefix + '-trace', sourceId: prefix + '-source',
    revisionId: prefix + '-revision', candidateId: prefix + '-candidate', contextId: prefix + '-context',
  };
  await database.executor.query(
    'INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata) ' +
    'VALUES ($1, $2, $3, \'succeeded\', \'{"fixture":"fiction-only"}\'::jsonb)',
    [f.traceId, datasetKind, FIRST],
  );
  await database.executor.query(
    'INSERT INTO waspada.source_registry ' +
    '(source_id, trace_id, registry_version, display_name, source_kind, remit, access_method, approved_hosts, ' +
    'access_restrictions, reuse_basis, registry_status, approval_status, health_status, auto_acquisition_enabled, auto_publication_policy) ' +
    'VALUES ($1, $2, 1, \'Fictional fixture source\', \'other\', ARRAY[\'fixture\'], \'manual_fixture\', ' +
    'ARRAY[]::text[], ARRAY[\'fictional\'], ARRAY[\'test\'], \'active\', \'pending\', \'unknown\', false, \'never\')',
    [f.sourceId, f.traceId],
  );
  await database.executor.query(
    'INSERT INTO waspada.report_revisions ' +
    '(dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json) ' +
    'VALUES ($1, $2, $3, $4, $5, $6, \'fictional text\', $7, \'briefing-test-v1\', $8, \'unreviewed\', \'{"fixture":"fiction-only"}\'::jsonb)',
    [datasetKind, f.revisionId, f.traceId, f.sourceId, 'https://' + prefix + '.invalid/test',
      'b'.repeat(64), 'a'.repeat(64), FIRST],
  );
  await database.executor.query(
    'INSERT INTO waspada.extraction_results (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json) ' +
    'VALUES ($1, $2, $3, $4, \'group_specific_critical_notices\', \'{"fixture":"fiction-only"}\'::jsonb)',
    [datasetKind, f.candidateId, f.traceId, f.revisionId],
  );
  await database.executor.query(
    'INSERT INTO waspada.grounding_contexts (dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version, sufficient, record_json) ' +
    'VALUES ($1, $2, $3, $4, \'briefing-test-v1\', \'briefing-test-index-v1\', true, \'{"fixture":"fiction-only"}\'::jsonb)',
    [datasetKind, f.contextId, f.traceId, f.candidateId],
  );
  return f;
}
async function seedScopeName(
  entityType: EntityType, entityId: string, version: number,
  status: 'approved' | 'held', name: string | null, locale = 'id-ID',
): Promise<void> {
  await database.executor.query(
    'INSERT INTO waspada.scope_name_review_decisions ' +
    '(review_decision_id, entity_type, entity_id, locale, review_version, decision_status, display_name, provenance_ref, reviewer_id, decision_reason, reviewed_at) ' +
    'VALUES ($1, $2, $3, $4, $5, $6, $7, \'authored-fixture\', \'fixture-reviewer\', \'fictional decision\', $8)',
    ['scope-review-' + entityId + '-v' + version, entityType, entityId, locale, version, status, name, FIRST],
  );
}
async function seedEvent(
  f: Fixture, eventId: string, version: number, status: 'published' | 'withdrawn',
  publishedAt: string | null, options: EventOptions = {},
): Promise<void> {
  const decision = f.prefix + '-decision-' + eventId + '-v' + version;
  const proposal = f.prefix + '-proposal-' + eventId + '-v' + version;
  const withdrawnAt = status === 'withdrawn' ? WITHDRAWN_AT : null;
  const reason = status === 'withdrawn' ? 'duplicate' : null;
  const record = eventRecord(f, eventId, version, status, publishedAt, withdrawnAt, reason, options);
  await database.executor.transaction(async (tx) => {
    await tx.execute('SET CONSTRAINTS ALL DEFERRED');
    await tx.query(
      'INSERT INTO waspada.event_proposals (dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id, base_event_version, proposed_at, record_json) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, \'{"fixture":"fiction-only"}\'::jsonb)',
      [f.datasetKind, proposal, f.traceId, f.candidateId, f.contextId, version === 1 ? null : eventId,
        version === 1 ? null : version - 1, FIRST],
    );
    await tx.query(
      'INSERT INTO waspada.publication_decisions (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id, event_version, decided_at, record_json) ' +
      'VALUES ($1, $2, $3, $4, \'briefing-test-policy\', $5, $6, $7, \'{"fixture":"fiction-only"}\'::jsonb)',
      [f.datasetKind, decision, f.traceId, proposal, eventId, version, FIRST],
    );
    await tx.query(
      'INSERT INTO waspada.event_versions ' +
      '(dataset_kind, event_id, version, trace_id, supersedes_version, title, summary, category, lifecycle, publication_status, withdrawal_reason, publication_decision_id, published_at, withdrawn_at, record_json) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)',
      [f.datasetKind, eventId, version, f.traceId, version === 1 ? null : version - 1,
        record.title, record.summary, options.category ?? 'group_specific_critical_notices', record.lifecycle, status, reason, decision,
        publishedAt, withdrawnAt, JSON.stringify(record)],
    );
  });
}
function eventRecord(
  f: Fixture, eventId: string, version: number, status: 'published' | 'withdrawn',
  publishedAt: string | null, withdrawnAt: string | null, reason: string | null, options: EventOptions,
): Record<string, unknown> {
  const claims = status === 'published'
    ? [{ claim_id: 'claim-' + eventId, scope: {} },
      ...(options.claimScopes ?? []).map((scope, index) => ({ claim_id: 'claim-extra-' + index, scope }))]
    : [];
  const scope = options.scope ?? {};
  return {
    schema_version: '2.0', trace_id: f.traceId, record_type: 'Event', dataset_kind: f.datasetKind,
    event_id: eventId, version, supersedes_version: version === 1 ? null : version - 1,
    title: 'Fictional briefing event', summary: 'Authored fictional content for a test.',
    category: options.recordCategory ?? options.category ?? 'group_specific_critical_notices', tags: [],
    lifecycle: 'unknown', freshness: { status: 'current', evaluated_at: FIRST, review_due_at: null, basis: 'unknown' },
    event_time: { start: null, end: null, precision: 'unknown' },
    validity: { valid_from: null, valid_until: null },
    scope: {
      place_ids: scope.place_ids ?? [], service_ids: scope.service_ids ?? [],
      institution_ids: scope.institution_ids ?? [], audience_ids: scope.audience_ids ?? [], geometry_ids: [],
    },
    claims, impact_refs: [], publication_status: status, withdrawal_reason: reason,
    publication_decision_id: f.prefix + '-decision-' + eventId + '-v' + version,
    published_at: publishedAt, withdrawn_at: withdrawnAt,
  };
}
async function seedImpact(
  f: Fixture, eventId: string, eventVersion: number, impactId: string, version: number, scope: ScopeIds,
): Promise<void> {
  const record = { scope: {
    place_ids: scope.place_ids ?? [], service_ids: scope.service_ids ?? [],
    institution_ids: scope.institution_ids ?? [], audience_ids: scope.audience_ids ?? [], geometry_ids: [],
  } };
  await database.executor.transaction(async (tx) => {
    await tx.execute('SET CONSTRAINTS ALL DEFERRED');
    await tx.query(
      'INSERT INTO waspada.impact_versions (dataset_kind, impact_id, version, trace_id, event_id, event_version, impact_type, lifecycle, published_at, record_json) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, \'other\', \'unknown\', $7, $8::jsonb)',
      [f.datasetKind, impactId, version, f.traceId, eventId, eventVersion, FIRST, JSON.stringify(record)],
    );
    await tx.query(
      'INSERT INTO waspada.event_impact_refs (dataset_kind, event_id, event_version, impact_id, impact_version) VALUES ($1, $2, $3, $4, $5)',
      [f.datasetKind, eventId, eventVersion, impactId, version],
    );
  });
}
function recordQueries(
  executor: SqlExecutor, calls: { statement: string; parameters: readonly unknown[] }[],
): SqlExecutor {
  return {
    async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
      calls.push({ statement, parameters: parameters ?? [] });
      return executor.query<Row>(statement, parameters);
    },
    execute(statement: string) { return executor.execute(statement); },
  };
}
function fakeExecutor(
  response: (statement?: string, parameters?: readonly unknown[]) => readonly unknown[],
): SqlExecutor {
  return {
    async query<Row extends object>(statement?: string, parameters?: readonly unknown[]) {
      return { rows: response(statement, parameters) as readonly Row[] };
    },
    async execute() {},
  };
}
