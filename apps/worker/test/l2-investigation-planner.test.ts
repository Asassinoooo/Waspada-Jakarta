import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createInvestigationPlanner,
  INVESTIGATION_PLAN_CAPABILITY,
  type InvestigationPlanProvider,
} from '../src/layers/l2-model-grounding/investigation-planner.js';

const baseMenu = [
  { name: 'synthetic_search', description: 'Search the synthetic source index.' },
  { name: 'gazetteer_lookup', description: 'Resolve a synthetic place name.' },
];

function groundingContext(options: {
  readonly sufficient?: boolean;
  readonly missingFields?: readonly string[];
  readonly conflicts?: readonly string[];
} = {}) {
  return {
    schemaVersion: '2.0',
    recordType: 'GroundingContext',
    datasetKind: 'synthetic',
    traceId: 'trace-plan-synthetic',
    contextId: 'context-plan-synthetic',
    candidateId: 'candidate-plan-synthetic',
    evidence: [],
    revisionStates: [],
    candidateEvents: [],
    priorDecisionIds: [],
    missingFields: options.missingFields ?? ['synthetic_service_status'],
    conflicts: options.conflicts ?? ['synthetic_reports_disagree'],
    retrievalVersion: 'synthetic-retrieval-v1',
    indexVersion: 'synthetic-index-v1',
    sufficient: options.sufficient ?? false,
  };
}

function labelsFor(missingCount = 1, conflictCount = 1): string[] {
  return [
    ...Array.from({ length: missingCount }, (_, index) => `missing_field_${index + 1}`),
    ...Array.from({ length: conflictCount }, (_, index) => `conflict_${index + 1}`),
  ];
}

function request(options: {
  readonly context?: ReturnType<typeof groundingContext>;
  readonly questions?: readonly string[];
  readonly actionMenu?: readonly unknown[];
} = {}) {
  return {
    schemaVersion: '1.0',
    recordType: 'InvestigationPlanRequest',
    groundingContext: options.context ?? groundingContext(),
    questions: options.questions ?? labelsFor(),
    actionMenu: options.actionMenu ?? baseMenu,
  };
}

function proposed(input: unknown = { query: 'synthetic query' }, actionName = 'synthetic_search') {
  return {
    schemaVersion: '1.0',
    recordType: 'InvestigationPlanResult',
    outcome: 'proposed',
    actionName,
    input,
  };
}

function abstained(reason: string) {
  return {
    schemaVersion: '1.0',
    recordType: 'InvestigationPlanResult',
    outcome: 'abstained',
    reason,
  };
}

function scriptedProvider(reply: unknown | (() => unknown | Promise<unknown>), onPlan?: (value: unknown) => void) {
  const calls: unknown[] = [];
  const provider: InvestigationPlanProvider = {
    async plan(value) {
      calls.push(value);
      onPlan?.(value);
      if (typeof reply === 'function') return await (reply as () => unknown | Promise<unknown>)();
      return reply;
    },
  };
  return { provider, calls };
}

function plannerResult(reply: unknown) {
  const scripted = scriptedProvider(reply);
  return { planner: createInvestigationPlanner(scripted.provider), calls: scripted.calls };
}

function inputByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function objectWithExactByteLength(targetBytes: number): Record<string, string> {
  const keys = ['k1', 'k2', 'k3', 'k4', 'k5'];
  const output = Object.fromEntries(keys.map((key) => [key, ''])) as Record<string, string>;
  let remaining = targetBytes - inputByteLength(output);
  assert.ok(remaining >= 0 && remaining <= keys.length * 2_048);
  for (const key of keys) {
    const length = Math.min(2_048, remaining);
    output[key] = 'x'.repeat(length);
    remaining -= length;
  }
  assert.equal(remaining, 0);
  assert.equal(inputByteLength(output), targetBytes);
  return output;
}

function nestedObject(depth: number): Record<string, unknown> {
  let output: Record<string, unknown> = {};
  for (let index = 1; index < depth; index += 1) output = { child: output };
  return output;
}

test('rejects malformed and sufficient contexts before calling the provider', async () => {
  const scripted = scriptedProvider(proposed());
  const planner = createInvestigationPlanner(scripted.provider);
  const cases = [
    request({ questions: ['private source text'] }),
    request({ context: groundingContext({ sufficient: true }) }),
    { ...request(), extra: 'unexpected' },
    { ...request(), schemaVersion: '2.0' },
    request({ context: { ...groundingContext(), evidence: [{ malformed: true }] } as ReturnType<typeof groundingContext> }),
  ];

  for (const invalid of cases) {
    const result = await planner.propose(invalid);
    assert.equal(result.status, 'invalid_request');
    assert.equal(JSON.stringify(result).includes('private source text'), false);
  }
  assert.equal(scripted.calls.length, 0);
});

test('enforces question projection and its one-to-twenty bound', async () => {
  const validOne = request({
    context: groundingContext({ missingFields: ['synthetic_missing_field'], conflicts: [] }),
    questions: labelsFor(1, 0),
  });
  const validTwenty = request({
    context: groundingContext({ missingFields: Array.from({ length: 10 }, (_, i) => `missing_${i}`), conflicts: Array.from({ length: 10 }, (_, i) => `conflict_${i}`) }),
    questions: labelsFor(10, 10),
  });
  const { planner, calls } = plannerResult(proposed());
  assert.equal((await planner.propose(validOne)).status, 'succeeded');
  assert.equal((await planner.propose(validTwenty)).status, 'succeeded');

  const invalidRequests = [
    request({ context: groundingContext({ missingFields: [], conflicts: [] }), questions: [] }),
    request({ context: groundingContext({ missingFields: Array.from({ length: 21 }, (_, i) => `missing_${i}`), conflicts: [] }), questions: labelsFor(21, 0) }),
    request({ questions: ['conflict_1', 'missing_field_1'] }),
    request({ questions: ['missing_field_1', 'conflict_1', 'conflict_1'] }),
  ];
  for (const invalid of invalidRequests) {
    const result = await planner.propose(invalid);
    assert.deepEqual(result, {
      status: 'invalid_request',
      capability: INVESTIGATION_PLAN_CAPABILITY,
      reason: 'invalid_question_labels',
    });
  }
  assert.equal(calls.length, 2);
});

test('requires a bounded unique action menu before provider invocation', async () => {
  const scripted = scriptedProvider(proposed());
  const planner = createInvestigationPlanner(scripted.provider);
  const invalidMenus = [
    [],
    Array.from({ length: 17 }, (_, index) => ({ name: `action_${index}`, description: 'Synthetic action.' })),
    [{ name: 'duplicate', description: 'First.' }, { name: 'duplicate', description: 'Second.' }],
    [{ name: 'synthetic_search', description: '   ' }],
    [{ name: 'synthetic_search', description: 'd'.repeat(257) }],
    [{ name: 'invalid name', description: 'Synthetic action.' }],
    [{ name: 'synthetic_search', description: 'Synthetic action.', host: 'example.invalid' }],
  ];
  for (const actionMenu of invalidMenus) {
    const result = await planner.propose(request({ actionMenu }));
    assert.equal(result.status, 'invalid_request');
    if (result.status === 'invalid_request') assert.equal(result.reason, 'invalid_action_menu');
  }
  assert.equal(scripted.calls.length, 0);

  const validBoundaryMenus = [
    [{ name: 'single_action', description: 'One trusted synthetic action.' }],
    Array.from({ length: 16 }, (_, index) => ({ name: `action_${index}`, description: 'Synthetic action.' })),
  ];
  for (const actionMenu of validBoundaryMenus) {
    const output = actionMenu.length === 1
      ? proposed({}, 'single_action')
      : proposed({}, 'action_15');
    const boundaryProvider = scriptedProvider(output);
    const result = await createInvestigationPlanner(boundaryProvider.provider).propose(request({ actionMenu }));
    assert.equal(result.status, 'succeeded');
    assert.equal(boundaryProvider.calls.length, 1);
  }
});

test('accepts one menu action as a frozen, copied proposal without execution authority', async () => {
  const originalInput = { query: 'synthetic query', filters: ['synthetic'] };
  let providerRequest: unknown;
  const scripted = scriptedProvider(proposed(originalInput), (value) => { providerRequest = value; });
  const planner = createInvestigationPlanner(scripted.provider);
  const result = await planner.propose(request());

  assert.deepEqual(result, {
    status: 'succeeded',
    capability: INVESTIGATION_PLAN_CAPABILITY,
    value: {
      schemaVersion: '1.0',
      recordType: 'InvestigationPlanResult',
      outcome: 'proposed',
      actionName: 'synthetic_search',
      input: { query: 'synthetic query', filters: ['synthetic'] },
    },
  });
  assert.equal(scripted.calls.length, 1);
  assert.ok(providerRequest && Object.isFrozen(providerRequest));
  const sent = providerRequest as { groundingContext: object; questions: object; actionMenu: object };
  assert.ok(Object.isFrozen(sent.groundingContext));
  assert.ok(Object.isFrozen(sent.questions));
  assert.ok(Object.isFrozen(sent.actionMenu));

  originalInput.query = 'mutated after provider return';
  assert.deepEqual(result.status === 'succeeded' && result.value.outcome === 'proposed' ? result.value.input : null, {
    query: 'synthetic query',
    filters: ['synthetic'],
  });
});

test('accepts only one of the fixed abstention outcomes', async () => {
  for (const reason of ['no_available_action', 'ambiguous_context', 'cannot_form_valid_input']) {
    const { planner, calls } = plannerResult(abstained(reason));
    const result = await planner.propose(request());
    assert.deepEqual(result, {
      status: 'succeeded',
      capability: INVESTIGATION_PLAN_CAPABILITY,
      value: {
        schemaVersion: '1.0',
        recordType: 'InvestigationPlanResult',
        outcome: 'abstained',
        reason,
      },
    });
    assert.equal(calls.length, 1);
  }
});

test('provider absence is a typed closed outcome', async () => {
  const result = await createInvestigationPlanner().propose(request());
  assert.deepEqual(result, {
    status: 'not_configured',
    capability: INVESTIGATION_PLAN_CAPABILITY,
    reason: 'provider_not_configured',
  });
});

test('calls the provider once and rejects unknown actions, extra fields, and authority claims', async () => {
  const invalidOutputs = [
    proposed({}, 'arbitrary_source_fetch'),
    { ...proposed(), unexpected: 'private model text' },
    { ...proposed(), sufficient: true },
    { ...proposed(), budget: { modelTokens: 1_000_000 } },
    { ...proposed(), stopReason: 'completed' },
    { ...proposed(), publication: 'approved' },
    { ...abstained('ambiguous_context'), actionName: 'synthetic_search' },
    abstained('raw provider decision'),
    { ...proposed(), schemaVersion: '2.0' },
  ];
  for (const output of invalidOutputs) {
    const { planner, calls } = plannerResult(output);
    const result = await planner.propose(request());
    assert.deepEqual(result, {
      status: 'invalid_output',
      capability: INVESTIGATION_PLAN_CAPABILITY,
      reason: 'invalid_output',
    });
    assert.equal(calls.length, 1);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('accepts the exact UTF-8 byte bound and rejects input one byte over it', async () => {
  const atLimit = objectWithExactByteLength(8 * 1024);
  const withinLimit = plannerResult(proposed(atLimit));
  assert.equal((await withinLimit.planner.propose(request())).status, 'succeeded');
  assert.equal(withinLimit.calls.length, 1);

  const overLimit = { ...atLimit, k5: `${atLimit.k5}x` };
  assert.equal(inputByteLength(overLimit), 8 * 1024 + 1);
  const oversized = plannerResult(proposed(overLimit));
  assert.deepEqual(await oversized.planner.propose(request()), {
    status: 'invalid_output',
    capability: INVESTIGATION_PLAN_CAPABILITY,
    reason: 'invalid_output',
  });
  assert.equal(oversized.calls.length, 1);

  const multibyte = plannerResult(proposed({ value: 'é'.repeat(2_048), second: 'é'.repeat(2_048) }));
  assert.ok(inputByteLength({ value: 'é'.repeat(2_048), second: 'é'.repeat(2_048) }) > 8 * 1024);
  assert.equal((await multibyte.planner.propose(request())).status, 'invalid_output');
});

test('enforces nesting, key, item, and string bounds', async () => {
  const cases: Array<{ readonly input: unknown; readonly valid: boolean }> = [
    { input: nestedObject(8), valid: true },
    { input: nestedObject(9), valid: false },
    { input: { [
      'k'.repeat(64)
    ]: 'ok' }, valid: true },
    { input: { ['k'.repeat(65)]: 'ok' }, valid: false },
    { input: { value: 's'.repeat(2_048) }, valid: true },
    { input: { value: 's'.repeat(2_049) }, valid: false },
    { input: Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`key_${index}`, index])), valid: true },
    { input: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key_${index}`, index])), valid: false },
    { input: { values: Array.from({ length: 32 }, (_, index) => index) }, valid: true },
    { input: { values: Array.from({ length: 33 }, (_, index) => index) }, valid: false },
  ];

  for (const { input, valid } of cases) {
    const { planner } = plannerResult(proposed(input));
    assert.equal((await planner.propose(request())).status === 'succeeded', valid);
  }
});

test('rejects prototype-bearing, cyclic, accessor, sparse, and non-JSON action inputs', async () => {
  const inherited = Object.create({ inherited: true }) as Record<string, unknown>;
  inherited.value = 'synthetic';
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const accessor = {};
  Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'synthetic' });
  const symbolKey = { value: 'synthetic', [Symbol('hidden')]: 'hidden' };
  const sparse = new Array(2);
  sparse[1] = 'synthetic';
  const customArray = ['synthetic'] as unknown[] & { extra?: string };
  customArray.extra = 'hidden';
  const invalidInputs = [
    inherited,
    Object.create(null),
    cyclic,
    accessor,
    symbolKey,
    { value: undefined },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: 1n },
    { value: Symbol('synthetic') },
    { value: () => 'synthetic' },
    { values: sparse },
    { values: customArray },
  ];

  for (const input of invalidInputs) {
    const { planner } = plannerResult(proposed(input));
    const result = await planner.propose(request());
    assert.deepEqual(result, {
      status: 'invalid_output',
      capability: INVESTIGATION_PLAN_CAPABILITY,
      reason: 'invalid_output',
    });
    assert.equal(JSON.stringify(result).includes('synthetic'), false);
  }
});

test('provider failures are reduced to a generic typed outcome', async () => {
  const rawMessage = 'private source text and provider diagnostic';
  const scripted = scriptedProvider(() => { throw new Error(rawMessage); });
  const result = await createInvestigationPlanner(scripted.provider).propose(request());
  assert.deepEqual(result, {
    status: 'provider_error',
    capability: INVESTIGATION_PLAN_CAPABILITY,
  });
  assert.equal(scripted.calls.length, 1);
  assert.equal(JSON.stringify(result).includes(rawMessage), false);
});
