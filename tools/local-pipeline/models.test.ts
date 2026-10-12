import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { resolveLocalModels } from './models.js';

const validEnv: NodeJS.ProcessEnv = {
  NINEROUTER_URL: 'https://gateway.example/v1',
  NINEROUTER_KEY: 'synthetic-local-test-key',
  NINEROUTER_CURATION_EPOCH: 'local-test-epoch',
};

test('mock resolution ignores secret environment and never invokes provider transport', () => {
  let fetchCalls = 0;
  const env = new Proxy({} as NodeJS.ProcessEnv, { get() { throw new Error('secret_environment_read'); } });
  const models = resolveLocalModels({ realAi: false, omitExtractionOutputLimits: false, env,
    fetchImpl: (async () => { fetchCalls += 1; throw new Error('provider_http'); }) as typeof fetch });
  assert.equal(models.profileId, 'local-mock-v1');
  assert.equal(models.configuration.extraction?.provider, 'local_mock');
  assert.equal(fetchCalls, 0);
  assert.throws(() => resolveLocalModels({ realAi: false, omitExtractionOutputLimits: true, env }), /invalid_local_options/);
});

test('legacy real profile identity stays stable and diagnostic omission gets a separate identity', () => {
  const regular = resolveLocalModels({ realAi: true, omitExtractionOutputLimits: false, env: validEnv });
  const diagnostic = resolveLocalModels({ realAi: true, omitExtractionOutputLimits: true, env: validEnv });
  const gatewayFingerprint = new URL(validEnv.NINEROUTER_URL!).href.replace(/\/+$/, '');
  const legacyFingerprint = JSON.stringify([gatewayFingerprint, regular.configuration]);
  const expectedLegacyId = `real-${createHash('sha256').update(legacyFingerprint).digest('hex')}`;
  assert.equal(regular.profileId, expectedLegacyId);
  assert.notEqual(diagnostic.profileId, regular.profileId);
  assert.equal(regular.profileId.includes(validEnv.NINEROUTER_KEY!), false);
  assert.equal(diagnostic.profileId.includes(validEnv.NINEROUTER_KEY!), false);
  assert.equal(JSON.stringify(regular.configuration).includes(validEnv.NINEROUTER_KEY!), false);
  assert.equal(JSON.stringify(regular.configuration).includes(validEnv.NINEROUTER_URL!), false);
});

test('diagnostic omits extraction max_tokens while classification and reasoning retain bounded caps', async () => {
  const report = {
    reportRevisionId: 'revision-test-1',
    permittedTextHash: createHash('sha256').update('abc').digest('hex'),
    normalizationVersion: 'normalization-v1',
    permittedText: 'abc',
  };
  const evidence = [{ reportRevisionId: report.reportRevisionId, permittedTextHash: report.permittedTextHash,
    spanStart: 0, spanEnd: 3, offsetUnit: 'unicode_code_points', relation: 'supports' }];
  const outputs = [
    { category: 'disasters_weather', tags: [], eventTime: { start: null, end: null, precision: 'unknown' },
      scope: { placeIds: [], serviceIds: [], institutionIds: [], audienceIds: [], geometryIds: [] }, evidence, unknownFields: ['event_time'] },
    { category: 'disasters_weather', evidence, unknownFields: [] },
    { outcome: 'abstained', claims: [], unresolvedFields: ['event_time'] },
  ];
  const calls: Array<{ url: string; method: string | undefined; body: Record<string, unknown> }> = [];
  let responseIndex = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(input), method: init?.method, body });
    const output = outputs[responseIndex++];
    return new Response(JSON.stringify({
      model: 'Waspada-Jakarta',
      choices: [{ message: { content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const models = resolveLocalModels({ realAi: true, omitExtractionOutputLimits: true, env: validEnv, fetchImpl });
  assert.equal(calls.length, 0);

  const extraction = await models.adapter.extract({ data: { candidateId: 'candidate-test-1', report } });
  const classification = await models.adapter.classify({ data: { report } });
  const reasoning = await models.adapter.reason({ data: { groundingContext: {
    schemaVersion: '2.0', recordType: 'GroundingContext', datasetKind: 'synthetic', traceId: 'trace-test-1',
    contextId: 'context-test-1', candidateId: 'candidate-test-1', evidence: [], revisionStates: [],
    candidateEvents: [], priorDecisionIds: [], missingFields: [], conflicts: [], retrievalVersion: 'retrieval-v1',
    indexVersion: 'index-v1', sufficient: false,
  } } });
  assert.equal(extraction.status, 'succeeded');
  assert.equal(classification.status, 'succeeded');
  assert.equal(reasoning.status, 'succeeded');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(({ url }) => url), Array(3).fill('https://gateway.example/v1/chat/completions'));
  assert.deepEqual(calls.map(({ method }) => method), Array(3).fill('POST'));
  assert.deepEqual(Object.keys(calls[0]!.body).sort(), ['messages', 'model', 'stream']);
  assert.equal(calls[0]!.body.model, 'Waspada-Jakarta');
  assert.equal(calls[0]!.body.stream, false);
  for (const call of calls.slice(1)) {
    assert.equal(typeof call.body.max_tokens, 'number');
    assert.ok((call.body.max_tokens as number) > 0 && (call.body.max_tokens as number) <= 4_096);
  }
});

test('default real extraction keeps its existing bounded output cap', async () => {
  const report = { reportRevisionId: 'revision-default-1', permittedTextHash: createHash('sha256').update('abc').digest('hex'),
    normalizationVersion: 'normalization-v1', permittedText: 'abc' };
  const body = { category: 'disasters_weather', tags: [], eventTime: { start: null, end: null, precision: 'unknown' },
    scope: { placeIds: [], serviceIds: [], institutionIds: [], audienceIds: [], geometryIds: [] },
    evidence: [{ reportRevisionId: report.reportRevisionId, permittedTextHash: report.permittedTextHash,
      spanStart: 0, spanEnd: 3, offsetUnit: 'unicode_code_points', relation: 'supports' }], unknownFields: ['event_time'] };
  let captured: Record<string, unknown> | undefined;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ model: 'Waspada-Jakarta', choices: [{ message: { content: JSON.stringify(body) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const models = resolveLocalModels({ realAi: true, omitExtractionOutputLimits: false, env: validEnv, fetchImpl });
  const result = await models.adapter.extract({ data: { candidateId: 'candidate-default-1', report } });
  assert.equal(result.status, 'succeeded');
  assert.equal(typeof captured?.max_tokens, 'number');
  assert.ok((captured?.max_tokens as number) > 0 && (captured?.max_tokens as number) <= 4_096);
});

test('invalid real gateway configuration returns a closed error without secret details', () => {
  const secret = 'SENTINEL_PRIVATE_GATEWAY_KEY';
  const invalidEnvs: NodeJS.ProcessEnv[] = [
    {},
    { ...validEnv, NINEROUTER_URL: `https://${secret}.example/private/path` },
    { ...validEnv, NINEROUTER_KEY: undefined },
    { ...validEnv, NINEROUTER_CURATION_EPOCH: `${secret} ` },
  ];
  let fetchCalls = 0;
  for (const env of invalidEnvs) {
    assert.throws(() => resolveLocalModels({ realAi: true, omitExtractionOutputLimits: true, env,
      fetchImpl: (async () => { fetchCalls += 1; throw new Error('provider_http'); }) as typeof fetch }),
    (error: unknown) => error instanceof Error && error.message === 'invalid_local_configuration' && !error.message.includes(secret));
  }
  assert.equal(fetchCalls, 0);
});
