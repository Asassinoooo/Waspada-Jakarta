import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  EvidenceReference,
  ModelAdapterConfiguration,
  ModelCapabilityAdapter,
  UntrustedModelProvider,
} from "../../apps/worker/src/layers/l2-model-grounding/contracts.js";
import { createModelCapabilityAdapter } from "../../apps/worker/src/layers/l2-model-grounding/adapter.js";
import {
  createInvestigationPlanner,
  type InvestigationPlanProvider,
} from "../../apps/worker/src/layers/l2-model-grounding/investigation-planner.js";
import { sha256Text } from "../../apps/worker/src/layers/l2-model-grounding/validation.js";
import { createSyntheticModelSmokeFixtures } from "./ninerouter-fixtures.js";
import { runSyntheticModelSmoke } from "./ninerouter-smoke.js";

type ReferenceMode =
  | "narrow_multiple"
  | "whole_report"
  | "wrong_identity"
  | "out_of_range"
  | "unrelated_disclaimer"
  | "unrelated_emoji";

interface ScriptOptions {
  readonly referenceMode?: ReferenceMode;
  readonly failClassification?: boolean;
}

interface ScriptedBoundaries {
  readonly adapter: ModelCapabilityAdapter;
  readonly planner: ReturnType<typeof createInvestigationPlanner>;
  readonly events: string[];
  readonly maximumActiveCalls: () => number;
  readonly plannerObservation: () => {
    readonly request: unknown;
    readonly signal: AbortSignal;
    readonly maxTotalTokens: number;
  } | undefined;
}

const configuration: ModelAdapterConfiguration = {
  classification: { provider: "scripted-synthetic", modelVersion: "class-v1", promptVersion: "class-prompt-v1" },
  extraction: { provider: "scripted-synthetic", modelVersion: "extract-v1", promptVersion: "extract-prompt-v1" },
  embedding: {
    provider: "scripted-synthetic",
    modelVersion: "embed-v1",
    dimensions: 4,
    distanceMetric: "cosine",
    vectorIndexVersion: "synthetic-index-v1",
  },
  reasoning: { provider: "scripted-synthetic", modelVersion: "reason-v1", promptVersion: "reason-prompt-v1" },
};

function envelope(output: unknown) {
  return { output, usage: { inputTokens: 12, outputTokens: 3 } };
}

function findPhraseSpan(reportText: string, phrase: string): Pick<EvidenceReference, "spanStart" | "spanEnd"> {
  const codePoints = Array.from(reportText);
  const phrasePoints = Array.from(phrase);
  for (let start = 0; start <= codePoints.length - phrasePoints.length; start += 1) {
    if (phrasePoints.every((point, offset) => codePoints[start + offset] === point)) {
      return { spanStart: start, spanEnd: start + phrasePoints.length };
    }
  }
  throw new Error("synthetic_fixture_phrase_missing");
}

function makeEvidenceReferences(
  canonical: EvidenceReference,
  reportText: string,
  mode: ReferenceMode,
): readonly EvidenceReference[] {
  const codePoints = Array.from(reportText);
  if (mode === "whole_report") return [canonical];
  if (mode === "wrong_identity") {
    return [{ ...canonical, reportRevisionId: "revision_synthetic_wrong" }];
  }
  if (mode === "out_of_range") {
    return [{ ...canonical, spanEnd: codePoints.length + 1 }];
  }
  if (mode === "unrelated_disclaimer" || mode === "unrelated_emoji") {
    const phrase = mode === "unrelated_disclaimer" ? "data ini bukan laporan nyata" : "🧪";
    return [{ ...canonical, ...findPhraseSpan(reportText, phrase) }];
  }
  const anchorSpan = findPhraseSpan(reportText, "layanan air");
  const placeSpan = findPhraseSpan(reportText, "Zona Uji A");
  return [
    { ...canonical, ...anchorSpan },
    { ...canonical, ...placeSpan },
  ];
}

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

function makeScriptedBoundaries(options: ScriptOptions = {}): ScriptedBoundaries {
  const events: string[] = [];
  let activeCalls = 0;
  let maxActiveCalls = 0;
  let planObservation: ScriptedBoundaries["plannerObservation"] extends () => infer T ? T : never;
  const invoke = async <T>(name: string, action: () => T): Promise<T> => {
    events.push(name);
    activeCalls += 1;
    maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
    await delay();
    try {
      return action();
    } finally {
      activeCalls -= 1;
    }
  };

  const provider: UntrustedModelProvider = {
    async classify(request) {
      return invoke("classification", async () => {
        if (options.failClassification) throw new Error("synthetic_private_provider_detail");
        const report = request.data.report;
        const canonical: EvidenceReference = {
          reportRevisionId: report.reportRevisionId,
          permittedTextHash: report.permittedTextHash,
          spanStart: 0,
          spanEnd: Array.from(report.permittedText).length,
          offsetUnit: "unicode_code_points",
          relation: "supports",
        };
        return envelope({
          category: "utilities_essential_services",
          evidence: makeEvidenceReferences(
            canonical,
            report.permittedText,
            options.referenceMode ?? "narrow_multiple",
          ),
          unknownFields: [],
        });
      });
    },
    async extract(request) {
      return invoke("extraction", () => {
        const report = request.data.report;
        const canonical: EvidenceReference = {
          reportRevisionId: report.reportRevisionId,
          permittedTextHash: report.permittedTextHash,
          spanStart: 0,
          spanEnd: Array.from(report.permittedText).length,
          offsetUnit: "unicode_code_points",
          relation: "supports",
        };
        return envelope({
          category: "utilities_essential_services",
          tags: [{ namespace: "service", value: "synthetic_water_service" }],
          eventTime: {
            start: "2026-10-12T09:15:00+07:00",
            end: "2026-10-12T09:15:00+07:00",
            precision: "exact",
          },
          scope: { placeIds: [], serviceIds: [], institutionIds: [], audienceIds: [], geometryIds: [] },
          evidence: makeEvidenceReferences(
            canonical,
            report.permittedText,
            options.referenceMode ?? "narrow_multiple",
          ),
          unknownFields: [],
        });
      });
    },
    async embed() {
      return invoke("embedding", () => ({ vector: [0.1, 0.2, 0.3, 0.4] }));
    },
    async reason() {
      return invoke("reasoning", () => envelope({
        outcome: "abstained",
        claims: [],
        unresolvedFields: ["synthetic_reasoner_abstained"],
      }));
    },
  };

  const plannerProvider: InvestigationPlanProvider = {
    async plan(request, callOptions) {
      return invoke("planning", () => {
        planObservation = {
          request,
          signal: callOptions.signal,
          maxTotalTokens: callOptions.maxTotalTokens,
        };
        return {
          result: {
            schemaVersion: "1.0",
            recordType: "InvestigationPlanResult",
            outcome: "abstained",
            reason: "ambiguous_context",
          },
          inputTokens: 10,
          outputTokens: 4,
        };
      });
    },
  };

  return {
    adapter: createModelCapabilityAdapter(provider, configuration),
    planner: createInvestigationPlanner(plannerProvider, {
      modelVersion: "planner-v1",
      promptVersion: "planner-prompt-v1",
    }),
    events,
    maximumActiveCalls: () => maxActiveCalls,
    plannerObservation: () => planObservation,
  };
}

test("synthetic fixtures use exact Unicode hashes and immutable, explicitly synthetic evidence", async () => {
  const fixtures = await createSyntheticModelSmokeFixtures();

  assert.equal(fixtures.fixtureId, "ninerouter_synthetic_smoke_v1");
  assert.equal(fixtures.manifestMetadata.datasetKind, "synthetic");
  assert.equal(fixtures.manifestMetadata.reportDate, "2026-10-12");
  assert.equal(fixtures.manifestMetadata.geometry, null);
  assert.match(fixtures.reportText, /🧪/u);
  assert.equal(fixtures.reportTextHash, await sha256Text(fixtures.reportText));
  assert.equal(fixtures.contraryReportTextHash, await sha256Text(fixtures.contraryReportText));
  assert.equal(fixtures.supportReference.spanEnd, Array.from(fixtures.reportText).length);
  assert.equal(fixtures.contraryReference.spanEnd, Array.from(fixtures.contraryReportText).length);
  assert.deepEqual(
    fixtures.sufficientReasoningRequest.data.groundingContext.evidence.map(({ revisionStatus }) => revisionStatus),
    ["unreviewed", "unreviewed"],
  );
  assert.deepEqual(
    fixtures.sufficientReasoningRequest.data.groundingContext.evidence.map(({ observedAt, publishedAt }) => ({ observedAt, publishedAt })),
    [
      { observedAt: "2026-10-12T09:15:00+07:00", publishedAt: "2026-10-12T09:16:00+07:00" },
      { observedAt: "2026-10-12T09:20:00+07:00", publishedAt: "2026-10-12T09:21:00+07:00" },
    ],
  );
  assert.ok(Object.isFrozen(fixtures));
  assert.ok(Object.isFrozen(fixtures.sufficientReasoningRequest.data.groundingContext.evidence[0]));
  assert.ok(Object.isFrozen(fixtures.plannerActionMenu[0]));
});

test("smoke composes all five injected boundaries serially and accepts multiple narrow spans", async () => {
  const fixtures = await createSyntheticModelSmokeFixtures();
  const scripted = makeScriptedBoundaries();
  const controller = new AbortController();
  const summary = await runSyntheticModelSmoke({
    adapter: scripted.adapter,
    planner: scripted.planner,
    signal: controller.signal,
  });

  assert.equal(summary.success, true);
  assert.deepEqual(scripted.events, ["classification", "extraction", "embedding", "reasoning", "planning"]);
  assert.equal(scripted.maximumActiveCalls(), 1);
  assert.deepEqual(summary.callCounts, {
    classification: 1,
    extraction: 1,
    embedding: 1,
    sufficientReasoning: 1,
    insufficientReasoning: 0,
    investigationPlanning: 1,
    directReasoningService: 2,
    totalInjectedCapabilityCalls: 5,
  });
  assert.equal(summary.lineage.classificationEvidenceMatchesFixture, true);
  assert.equal(summary.lineage.extractionEvidenceMatchesFixture, true);
  assert.equal(summary.lineage.sufficientContraryEvidencePreserved, true);
  assert.equal(summary.lineage.insufficientContraryEvidencePreserved, true);
  assert.equal(summary.lineage.refsOnlyContextsPersisted, true);
  assert.equal(summary.branches.insufficient.reasonerSkipped, true);
  assert.equal(summary.branches.insufficient.plannerInvoked, true);
  assert.equal(summary.capabilities.insufficientContext.status, "investigation_required");
  assert.equal(summary.actionExecuted, false);
  assert.equal(summary.publicationAttempted, false);

  const observation = scripted.plannerObservation();
  assert.ok(observation);
  assert.equal(observation.signal, controller.signal);
  assert.equal(observation.maxTotalTokens, 12_000);
  assert.deepEqual(observation.request, {
    schemaVersion: "1.0",
    recordType: "InvestigationPlanRequest",
    groundingContext: fixtures.insufficientReasoningRequest.data.groundingContext,
    questions: ["missing_field_1", "conflict_1"],
    actionMenu: fixtures.plannerActionMenu,
  });
  assert.equal(JSON.stringify(summary).includes(fixtures.reportText), false);
});

test("whole-report citations remain valid for the synthetic source fixture", async () => {
  const scripted = makeScriptedBoundaries({ referenceMode: "whole_report" });
  const summary = await runSyntheticModelSmoke({ adapter: scripted.adapter, planner: scripted.planner });

  assert.equal(summary.success, true);
  assert.equal(summary.lineage.classificationEvidenceMatchesFixture, true);
  assert.equal(summary.lineage.extractionEvidenceMatchesFixture, true);
});

test("wrong report identity and out-of-range evidence fail validation without leaking provider output", async (t) => {
  for (const referenceMode of ["wrong_identity", "out_of_range"] as const) {
    await t.test(referenceMode, async () => {
      const scripted = makeScriptedBoundaries({ referenceMode });
      const summary = await runSyntheticModelSmoke({ adapter: scripted.adapter, planner: scripted.planner });

      assert.equal(summary.success, false);
      assert.equal(summary.capabilities.classification.status, "invalid_output");
      assert.equal(summary.lineage.classificationEvidenceMatchesFixture, false);
      assert.equal(summary.capabilities.extraction.status, "invalid_output");
      assert.equal(summary.lineage.extractionEvidenceMatchesFixture, false);
      assert.deepEqual(scripted.events, ["classification", "extraction", "embedding", "reasoning", "planning"]);
      assert.equal(JSON.stringify(summary).includes("revision_synthetic_wrong"), false);
      assert.equal(JSON.stringify(summary).includes("synthetic_private_provider_detail"), false);
    });
  }
});

test("in-range disclaimer and emoji citations fail the limited synthetic citation oracle", async (t) => {
  for (const referenceMode of ["unrelated_disclaimer", "unrelated_emoji"] as const) {
    await t.test(referenceMode, async () => {
      const scripted = makeScriptedBoundaries({ referenceMode });
      const summary = await runSyntheticModelSmoke({ adapter: scripted.adapter, planner: scripted.planner });
      const serialized = JSON.stringify(summary);

      assert.equal(summary.success, false);
      assert.equal(summary.capabilities.classification.status, "succeeded");
      assert.equal(summary.capabilities.extraction.status, "succeeded");
      assert.equal(summary.lineage.classificationEvidenceMatchesFixture, false);
      assert.equal(summary.lineage.extractionEvidenceMatchesFixture, false);
      assert.equal(serialized.includes("data ini bukan laporan nyata"), false);
      assert.equal(serialized.includes("🧪"), false);
      assert.equal(serialized.includes("Laporan sintetis untuk latihan"), false);
    });
  }
});

test("typed provider failures are retained and unrelated probes continue without error text", async () => {
  const scripted = makeScriptedBoundaries({ failClassification: true });
  const summary = await runSyntheticModelSmoke({ adapter: scripted.adapter, planner: scripted.planner });

  assert.equal(summary.success, false);
  assert.deepEqual(summary.capabilities.classification, { status: "provider_error", reason: "provider_error" });
  assert.equal(summary.capabilities.extraction.status, "succeeded");
  assert.equal(summary.capabilities.embedding.status, "succeeded");
  assert.equal(summary.capabilities.sufficientReasoning.status, "succeeded");
  assert.equal(summary.capabilities.investigationPlanning.status, "succeeded");
  assert.deepEqual(scripted.events, ["classification", "extraction", "embedding", "reasoning", "planning"]);
  assert.equal(JSON.stringify(summary).includes("synthetic_private_provider_detail"), false);
});

test("an aborted planner signal reaches the proposal boundary but never invokes its provider", async () => {
  const scripted = makeScriptedBoundaries();
  const controller = new AbortController();
  controller.abort();
  const summary = await runSyntheticModelSmoke({
    adapter: scripted.adapter,
    planner: scripted.planner,
    signal: controller.signal,
  });

  assert.equal(summary.success, false);
  assert.deepEqual(summary.capabilities.investigationPlanning, { status: "provider_error", reason: "provider_error" });
  assert.equal(summary.branches.insufficient.plannerInvoked, true);
  assert.deepEqual(scripted.events, ["classification", "extraction", "embedding", "reasoning"]);
  assert.equal(scripted.plannerObservation(), undefined);
  assert.equal(summary.callCounts.totalInjectedCapabilityCalls, 5);
});

test("unconfigured capabilities remain explicitly unavailable", async () => {
  const adapter = createModelCapabilityAdapter();
  const planner = createInvestigationPlanner();
  const summary = await runSyntheticModelSmoke({ adapter, planner });

  assert.equal(summary.success, false);
  assert.deepEqual(summary.capabilities.classification, { status: "not_configured", reason: "provider_not_configured" });
  assert.deepEqual(summary.capabilities.embedding, { status: "not_configured", reason: "provider_not_configured" });
  assert.deepEqual(summary.capabilities.investigationPlanning, { status: "not_configured", reason: "provider_not_configured" });
  assert.equal(summary.actionExecuted, false);
  assert.equal(summary.publicationAttempted, false);
});
