import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { resolveLocalModels } from './models.js';

const validEnv: NodeJS.ProcessEnv = {
  NINEROUTER_URL: 'https://gateway.example/v1',
  NINEROUTER_KEY: 'synthetic-local-test-key',
  NINEROUTER_CURATION_EPOCH: 'local-test-epoch',
};

function extractionFixture() {
  const text = 'A synthetic report for a long local model wait.';
  const report = {
    reportRevisionId: 'revision-long-wait-1',
    permittedTextHash: createHash('sha256').update(text).digest('hex'),
    normalizationVersion: 'normalization-v1',
    permittedText: text,
  };
  const evidence = [{ reportRevisionId: report.reportRevisionId, permittedTextHash: report.permittedTextHash,
    spanStart: 0, spanEnd: Array.from(text).length, offsetUnit: 'unicode_code_points', relation: 'supports' }];
  return {
    report,
    output: { category: 'disasters_weather', tags: [], eventTime: { start: null, end: null, precision: 'unknown' },
      scope: { placeIds: [], serviceIds: [], institutionIds: [], audienceIds: [], geometryIds: [] }, evidence, unknownFields: ['event_time'] },
  };
}

function embeddingChunk(text: string) {
  return {
    chunkId: 'chunk-local-transport-1',
    reportRevisionId: 'revision-local-transport-1',
    permittedTextHash: createHash('sha256').update('synthetic source').digest('hex'),
    normalizationVersion: 'normalization-v1',
    spanStart: 0,
    spanEnd: Array.from(text).length,
    offsetUnit: 'unicode_code_points' as const,
    chunkTextHash: createHash('sha256').update(text).digest('hex'),
    text,
  };
}

function embeddingResponse() {
  return JSON.stringify({ model: 'gemini/gemini-embedding-2-preview',
    data: [{ object: 'embedding', index: 0, embedding: Array.from({ length: 768 }, (_value, index) => index === 0 ? 0.25 : 0) }],
    usage: { prompt_tokens: 1, total_tokens: 1 } });
}

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

test('25-second real profile identity stays stable and other waits own separate profile identities', () => {
  const legacyEnv = { ...validEnv, NINEROUTER_TIMEOUT_MS: '25000' };
  const regular = resolveLocalModels({ realAi: true, omitExtractionOutputLimits: false, env: legacyEnv });
  const diagnostic = resolveLocalModels({ realAi: true, omitExtractionOutputLimits: true, env: legacyEnv });
  const gatewayFingerprint = new URL(validEnv.NINEROUTER_URL!).href.replace(/\/+$/, '');
  const legacyFingerprint = JSON.stringify([gatewayFingerprint, regular.configuration]);
  const expectedLegacyId = `real-${createHash('sha256').update(legacyFingerprint).digest('hex')}`;
  const defaultWait = resolveLocalModels({ realAi: true, omitExtractionOutputLimits: false, env: validEnv });
  const customWait = resolveLocalModels({ realAi: true, omitExtractionOutputLimits: false,
    env: { ...validEnv, NINEROUTER_TIMEOUT_MS: '120001' } });
  assert.equal(regular.profileId, expectedLegacyId);
  assert.equal(regular.requestTimeoutMs, 25_000);
  assert.equal(regular.modelTimeoutMs, 26_000);
  assert.notEqual(diagnostic.profileId, regular.profileId);
  assert.equal(defaultWait.requestTimeoutMs, 900_000);
  assert.equal(defaultWait.modelTimeoutMs, 901_000);
  assert.notEqual(defaultWait.profileId, regular.profileId);
  assert.notEqual(customWait.profileId, defaultWait.profileId);
  assert.equal(regular.profileId.includes(validEnv.NINEROUTER_KEY!), false);
  assert.equal(diagnostic.profileId.includes(validEnv.NINEROUTER_KEY!), false);
  assert.equal(JSON.stringify(regular.configuration).includes(validEnv.NINEROUTER_KEY!), false);
  assert.equal(JSON.stringify(regular.configuration).includes(validEnv.NINEROUTER_URL!), false);
});

test('local real timeout is private configuration bounded from 1,000 to 900,000 milliseconds', () => {
  for (const [timeout, expected] of [['1000', 1_000], ['01000', 1_000], ['900000', 900_000]] as const) {
    const models = resolveLocalModels({ realAi: true, omitExtractionOutputLimits: false,
      env: { ...validEnv, NINEROUTER_TIMEOUT_MS: timeout } });
    assert.equal(models.requestTimeoutMs, expected);
    assert.equal(models.modelTimeoutMs, expected + 1_000);
  }

  let fetchCalls = 0;
  for (const timeout of ['', '999', '900001', '1.5', '1e3', '-1000', ' 1000']) {
    assert.throws(() => resolveLocalModels({ realAi: true, omitExtractionOutputLimits: false,
      env: { ...validEnv, NINEROUTER_TIMEOUT_MS: timeout },
      fetchImpl: (async () => { fetchCalls += 1; throw new Error('provider_http'); }) as typeof fetch }),
    (error: unknown) => error instanceof Error && error.message === 'invalid_local_configuration');
  }
  assert.equal(fetchCalls, 0);
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

test('a synthetic extraction can succeed after the former 26-second local deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { report, output } = extractionFixture();
  let markStarted: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const fetchImpl = (async () => {
    markStarted?.();
    return await new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(JSON.stringify({
      model: 'Waspada-Jakarta',
      choices: [{ message: { content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })), 27_000));
  }) as typeof fetch;
  const models = resolveLocalModels({ realAi: true, omitExtractionOutputLimits: false, env: validEnv, fetchImpl });
  const pending = models.adapter.extract({ data: { candidateId: 'candidate-long-wait-1', report } });
  await requestStarted;
  t.mock.timers.tick(27_001);
  const result = await pending;
  assert.equal(result.status, 'succeeded');
  assert.equal(models.requestTimeoutMs, 900_000);
});

test('model cancellation settles even when an injected fetch ignores its signal', async () => {
  let markStarted: (() => void) | undefined;
  let receivedSignal: AbortSignal | null | undefined;
  const requestStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const observations: Array<{ capability: string; reason?: string }> = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    receivedSignal = init?.signal;
    markStarted?.();
    return await new Promise<Response>(() => undefined);
  }) as typeof fetch;
  const models = resolveLocalModels({ realAi: true, omitExtractionOutputLimits: false, env: validEnv, fetchImpl,
    onObservation: (observation) => observations.push(observation) });
  const { report } = extractionFixture();
  const pending = models.adapter.extract({ data: { candidateId: 'candidate-cancel-1', report } });
  await requestStarted;
  models.cancel?.();
  const result = await Promise.race([
    pending,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('cancellation_did_not_settle')), 500)),
  ]);
  assert.equal(result.status, 'provider_error');
  assert.equal(receivedSignal?.aborted, true);
  assert.equal(observations[0]?.reason, 'aborted');
});

test('model cancellation disposes a response returned after an injected fetch ignores abort', async () => {
  let markStarted: (() => void) | undefined;
  let resolveLateResponse: ((response: Response) => void) | undefined;
  let receivedSignal: AbortSignal | null | undefined;
  let markBodyCancelled: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const lateResponse = new Promise<Response>((resolve) => { resolveLateResponse = resolve; });
  const bodyCancelled = new Promise<void>((resolve) => { markBodyCancelled = resolve; });
  const observations: Array<{ capability: string; reason?: string }> = [];
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
    receivedSignal = init?.signal;
    markStarted?.();
    return lateResponse;
  }) as typeof fetch;
  const models = resolveLocalModels({ realAi: true, omitExtractionOutputLimits: false, env: validEnv, fetchImpl,
    onObservation: (observation) => observations.push(observation) });
  const { report } = extractionFixture();
  const pending = models.adapter.extract({ data: { candidateId: 'candidate-late-response-cancel-1', report } });
  await requestStarted;
  models.cancel?.();
  let settlementTimer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    pending,
    new Promise<never>((_resolve, reject) => {
      settlementTimer = setTimeout(() => reject(new Error('late_response_abort_did_not_settle')), 500);
    }),
  ]).finally(() => {
    if (settlementTimer !== undefined) clearTimeout(settlementTimer);
  });
  assert.equal(result.status, 'provider_error');
  assert.equal(receivedSignal?.aborted, true);
  assert.equal(observations[0]?.reason, 'aborted');

  resolveLateResponse?.(new Response(new ReadableStream<Uint8Array>({
    pull() { return new Promise<void>(() => undefined); },
    cancel() { markBodyCancelled?.(); },
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  let cancellationTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([bodyCancelled, new Promise<never>((_resolve, reject) => {
      cancellationTimer = setTimeout(() => reject(new Error('late_response_body_not_cancelled')), 500);
    })]);
  } finally {
    if (cancellationTimer !== undefined) clearTimeout(cancellationTimer);
  }
});

test('model cancellation remains active while an injected response body is pending', async () => {
  let markBodyStarted: (() => void) | undefined;
  const bodyStarted = new Promise<void>((resolve) => { markBodyStarted = resolve; });
  const observations: Array<{ capability: string; reason?: string }> = [];
  const fetchImpl = (async () => new Response(new ReadableStream<Uint8Array>({
    pull() {
      markBodyStarted?.();
      return new Promise<void>(() => undefined);
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const models = resolveLocalModels({ realAi: true, omitExtractionOutputLimits: false, env: validEnv, fetchImpl,
    onObservation: (observation) => observations.push(observation) });
  const { report } = extractionFixture();
  const pending = models.adapter.extract({ data: { candidateId: 'candidate-body-cancel-1', report } });
  await bodyStarted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  models.cancel?.();
  const result = await Promise.race([
    pending,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('body_cancellation_did_not_settle')), 500)),
  ]);
  assert.equal(result.status, 'provider_error');
  assert.equal(observations[0]?.reason, 'aborted');
});

test('known oversized response length cancels the body before returning the closed size reason', async () => {
  let markCancelled: (() => void) | undefined;
  const bodyCancelled = new Promise<void>((resolve) => { markCancelled = resolve; });
  const responseBody = new ReadableStream<Uint8Array>({
    pull() { return new Promise<void>(() => undefined); },
    cancel() { markCancelled?.(); },
  });
  const observations: Array<{ capability: string; reason?: string }> = [];
  const fetchImpl = (async () => new Response(responseBody, {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': '262145' },
  })) as typeof fetch;
  const models = resolveLocalModels({ realAi: true, omitExtractionOutputLimits: false, env: validEnv, fetchImpl,
    onObservation: (observation) => observations.push(observation) });
  const text = 'synthetic oversized embedding response';
  const result = await models.adapter.embed({ data: { chunk: embeddingChunk(text) } });

  assert.equal(result.status, 'provider_error');
  assert.equal(observations[0]?.reason, 'response_too_large');
  let cancellationTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([bodyCancelled, new Promise<never>((_resolve, reject) => {
      cancellationTimer = setTimeout(() => reject(new Error('oversized_body_not_cancelled')), 500);
    })]);
  } finally {
    if (cancellationTimer !== undefined) clearTimeout(cancellationTimer);
  }
});

test('long default waits use the native no-deadline transport while honoring loopback boundaries', async () => {
  let requestPath: string | undefined;
  const server = createServer((_request, response) => {
    requestPath = _request.url;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(embeddingResponse());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const originalFetch = globalThis.fetch;
  const observations: Array<{ capability: string; outcome: string; durationMs: number }> = [];
  try {
    globalThis.fetch = (async () => { throw new Error('short_default_transport_used'); }) as typeof fetch;
    const models = resolveLocalModels({ realAi: true, omitExtractionOutputLimits: false,
      env: { ...validEnv, NINEROUTER_URL: `http://127.0.0.1:${address.port}`, NINEROUTER_TIMEOUT_MS: '120001' },
      onObservation: (observation) => observations.push(observation) });
    const text = 'synthetic local embedding';
    const result = await models.adapter.embed({ data: { chunk: embeddingChunk(text) } });
    assert.equal(result.status, 'succeeded');
    assert.equal(requestPath, '/v1/embeddings');
    assert.equal(observations[0]?.capability, 'embedding');
    assert.equal(observations[0]?.outcome, 'succeeded');
    assert.equal(typeof observations[0]?.durationMs, 'number');
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
