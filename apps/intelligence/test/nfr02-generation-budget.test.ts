// TEST-GAP-02 / T6: NFR-02 resource bounds for the live intelligence agents.
// SDP NFR-02: 5 tool attempts, 4 reasoning turns, 60 active seconds or 12,000 model tokens,
// whichever comes first. Fake agents, fake timers and a fake model only; no network.
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { Agent } from "@mastra/core/agent";
import {
  GENERATION_MAX_ACTIVE_MS,
  GENERATION_MAX_INPUT_TOKENS,
  GENERATION_MAX_OUTPUT_TOKENS,
  GENERATION_MAX_STEPS,
  GENERATION_MAX_TOKENS,
  GENERATION_MAX_TOOL_ATTEMPTS,
  GENERATION_TOKEN_BUDGET_MARKER,
  estimateTokens,
  generateWithinBudget,
  startGenerationBudget,
} from "../src/agents/generation-budget.js";
import {
  REPORT_INTERPRETER_INSTRUCTIONS,
  createReportInterpretationAgent,
  interpretReport,
  type InterpretReportInput,
  type ReportInterpretation,
} from "../src/agents/report-interpretation-agent.js";
import {
  INCIDENT_CORRELATOR_INSTRUCTIONS,
  correlateIncident,
  createIncidentCorrelationAgent,
  type CorrelateIncidentInput,
} from "../src/agents/incident-correlation-agent.js";
import { classifyJobError } from "../src/job-runner.js";

interface GenerateOptions {
  readonly maxSteps?: number;
  readonly abortSignal?: AbortSignal;
  readonly modelSettings?: { readonly maxOutputTokens?: number };
}

interface GenerateCall {
  readonly prompt: unknown;
  readonly options: GenerateOptions | undefined;
}

/** A safety stop so that a run without the budget fails instead of hanging. */
const SAFETY_MS = 2_000;
const SAFETY_MESSAGE = "safety stop: the budget signal never fired";

/** Resolves only by rejecting when the signal aborts; the safety stop is the fallback. */
function waitForAbort(signal?: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const safety = setTimeout(() => reject(new Error(SAFETY_MESSAGE)), SAFETY_MS);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(safety);
        reject(signal?.reason);
      },
      { once: true },
    );
  });
}

function recordingAgent(text: string): { agent: Agent; calls: GenerateCall[] } {
  const calls: GenerateCall[] = [];
  const agent = {
    generate: async (prompt: unknown, options?: GenerateOptions) => {
      calls.push({ prompt, options });
      return { text };
    },
  } as unknown as Agent;
  return { agent, calls };
}

function hangingAgent(): { agent: Agent; calls: GenerateCall[] } {
  const calls: GenerateCall[] = [];
  const agent = {
    generate: (prompt: unknown, options?: GenerateOptions) => {
      calls.push({ prompt, options });
      return waitForAbort(options?.abortSignal);
    },
  } as unknown as Agent;
  return { agent, calls };
}

/** The largest prompt that still fits the input allowance beside the given instructions. */
function maxPromptCharsBeside(instructions: string): number {
  return 4 * (GENERATION_MAX_INPUT_TOKENS - estimateTokens(instructions));
}

const INTERPRETATION: ReportInterpretation = {
  summary: "Banjir setinggi 40 cm merendam Jalan Mampang Prapatan, Jakarta Selatan",
  incidentType: "banjir",
  severity: "medium",
  primaryCategory: "disasters_weather",
  location: { label: "Mampang Prapatan, Jakarta Selatan", approximateCoordinates: null, precision: "district" },
  eventTime: { value: null, precision: "unknown" },
  entities: [],
  impacts: [],
  operationalStatus: "active",
  evidence: [],
  conflictingInfo: [],
  uncertaintyNotes: [],
  confidence: "high",
};

const INTERPRETER_JSON = JSON.stringify(INTERPRETATION);

const NEW_INCIDENT_JSON = JSON.stringify({
  decision: "new_incident",
  candidateIncidentId: null,
  reasoning: "Tidak ada kandidat.",
  supportingEvidence: [],
  contradictoryEvidence: [],
  distinctions: [],
  unresolvedQuestions: [],
  uncertainty: [],
  has_discrepancy: false,
  discrepancy_summary: null,
});

function interpretInput(reportText: string): InterpretReportInput {
  return {
    reportRevisionId: "rev-nfr02-001",
    reportText,
    sourceKind: "rss",
    sourceDisplayName: "Fixture News",
    publishedAt: "2026-11-13T07:00:00.000Z",
    evidenceChunks: [
      { chunkId: "chk-nfr02-001", spanStart: 0, spanEnd: 40, text: "Banjir setinggi 40 cm merendam jalan." },
    ],
  };
}

function correlateInput(incomingReportText: string): CorrelateIncidentInput {
  return {
    incomingReportRevisionId: "rev-nfr02-002",
    incomingReportText,
    incomingInterpretation: INTERPRETATION,
    candidateIncidents: [],
  };
}

/** A real Mastra model object (spec v2). It answers, or it hangs until the call is aborted. */
function probeModel(mode: "answer" | "hang") {
  const calls: Array<{ maxOutputTokens: number | undefined; hasAbortSignal: boolean }> = [];
  const record = (options: { maxOutputTokens?: number; abortSignal?: AbortSignal }) => {
    calls.push({ maxOutputTokens: options.maxOutputTokens, hasAbortSignal: options.abortSignal !== undefined });
  };
  const model = {
    specificationVersion: "v2" as const,
    provider: "nfr02-probe",
    modelId: "nfr02-probe-model",
    supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate(options: { maxOutputTokens?: number; abortSignal?: AbortSignal }) {
      record(options);
      if (mode === "hang") return waitForAbort(options.abortSignal);
      return {
        content: [{ type: "text" as const, text: INTERPRETER_JSON }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [] as unknown[],
      };
    },
    async doStream(options: { maxOutputTokens?: number; abortSignal?: AbortSignal }) {
      record(options);
      if (mode === "hang") {
        const signal = options.abortSignal;
        return {
          stream: new ReadableStream({
            start(controller) {
              const safety = setTimeout(() => controller.error(new Error(SAFETY_MESSAGE)), SAFETY_MS);
              signal?.addEventListener(
                "abort",
                () => {
                  clearTimeout(safety);
                  controller.error(signal?.reason);
                },
                { once: true },
              );
            },
          }),
        };
      }
      const parts = [
        { type: "stream-start" as const, warnings: [] as unknown[] },
        { type: "text-start" as const, id: "probe-text-1" },
        { type: "text-delta" as const, id: "probe-text-1", delta: INTERPRETER_JSON },
        { type: "text-end" as const, id: "probe-text-1" },
        { type: "finish" as const, finishReason: "stop" as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
  return { model, calls };
}

function probeAgent(model: unknown): Agent {
  return new Agent({
    id: "nfr02-probe",
    name: "NFR-02 Probe",
    instructions: REPORT_INTERPRETER_INSTRUCTIONS,
    maxRetries: 0,
    model: model as unknown as ConstructorParameters<typeof Agent>[0]["model"],
  });
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("the call was expected to fail, but it succeeded");
}

describe("NFR-02 generation budget for the live intelligence agents", () => {
  afterEach(() => {
    mock.timers.reset();
  });

  describe("shared bounds", () => {
    it("holds the SDP NFR-02 numbers, with the input allowance beside the output cap", () => {
      assert.equal(GENERATION_MAX_STEPS, 4);
      assert.equal(GENERATION_MAX_TOOL_ATTEMPTS, 5);
      assert.equal(GENERATION_MAX_ACTIVE_MS, 60_000);
      assert.equal(GENERATION_MAX_TOKENS, 12_000);
      assert.equal(GENERATION_MAX_INPUT_TOKENS + GENERATION_MAX_OUTPUT_TOKENS, GENERATION_MAX_TOKENS);
    });
  });

  describe("active-time cap", () => {
    it("aborts the model call at 60 s and not before (fake timers)", () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      const budget = startGenerationBudget();
      mock.timers.tick(GENERATION_MAX_ACTIVE_MS - 1);
      assert.equal(budget.signal.aborted, false, "still active at 59.999 s");
      mock.timers.tick(1);
      assert.equal(budget.signal.aborted, true, "aborted at 60 s");
      assert.ok(budget.signal.reason instanceof Error, "the abort carries a reason");
      budget.dispose();
    });

    it("dispose stops the timer, so a finished call is not aborted later", () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      const budget = startGenerationBudget();
      budget.dispose();
      mock.timers.tick(GENERATION_MAX_ACTIVE_MS * 2);
      assert.equal(budget.signal.aborted, false);
    });
  });

  describe("generateWithinBudget", () => {
    it("passes at most 4 steps, a 60 s abort signal and a 4,000-token output cap to generate", async () => {
      const { agent, calls } = recordingAgent(INTERPRETER_JSON);
      await generateWithinBudget(agent, "Ringkas laporan singkat.", REPORT_INTERPRETER_INSTRUCTIONS);

      assert.equal(calls.length, 1);
      const options = calls[0]?.options;
      assert.ok(options?.maxSteps !== undefined, "maxSteps is passed");
      assert.ok(options.maxSteps >= 1 && options.maxSteps <= 4, `maxSteps ${options.maxSteps} is within 1..4`);
      assert.ok(options.abortSignal instanceof AbortSignal, "an abortSignal is passed");
      assert.equal(options.modelSettings?.maxOutputTokens, GENERATION_MAX_OUTPUT_TOKENS);
      assert.equal(options.abortSignal.aborted, false, "a call that finishes in time is not aborted");
    });

    it("refuses a prompt over the input allowance before any model call", async () => {
      const { agent, calls } = recordingAgent(INTERPRETER_JSON);
      const oversized = "a".repeat(maxPromptCharsBeside(REPORT_INTERPRETER_INSTRUCTIONS) + 1);

      const error = await captureRejection(generateWithinBudget(agent, oversized, REPORT_INTERPRETER_INSTRUCTIONS));
      assert.equal(calls.length, 0, "generate is never reached");
      assert.match(String((error as Error).message), new RegExp(GENERATION_TOKEN_BUDGET_MARKER));
      assert.equal(classifyJobError(error), "model_failed");
    });

    it("accepts a prompt exactly at the input allowance", async () => {
      const { agent, calls } = recordingAgent(INTERPRETER_JSON);
      const atLimit = "a".repeat(maxPromptCharsBeside(REPORT_INTERPRETER_INSTRUCTIONS));

      await generateWithinBudget(agent, atLimit, REPORT_INTERPRETER_INSTRUCTIONS);
      assert.equal(calls.length, 1);
    });

    it("cuts a hung model call at the time cap and classifies it as model_timeout, never as success", async () => {
      const { agent, calls } = hangingAgent();
      const startedAt = Date.now();

      const error = await captureRejection(generateWithinBudget(agent, "Ringkas laporan.", REPORT_INTERPRETER_INSTRUCTIONS, 20));
      assert.equal(calls.length, 1);
      assert.ok(Date.now() - startedAt < SAFETY_MS, "the budget, not the safety stop, ended the call");
      assert.equal(classifyJobError(error), "model_timeout");
    });

    it("treats a call that Mastra resolves as aborted as model_timeout, never as an empty answer", async () => {
      const agent = { generate: async () => ({ text: "", finishReason: "aborted" }) } as unknown as Agent;

      const error = await captureRejection(generateWithinBudget(agent, "Ringkas laporan.", REPORT_INTERPRETER_INSTRUCTIONS));
      assert.equal(classifyJobError(error), "model_timeout");
    });

    it("treats a call that stops at the output cap as a token-budget failure, never as a truncated answer", async () => {
      const agent = { generate: async () => ({ text: '{"summary":"Banjir', finishReason: "length" }) } as unknown as Agent;

      const error = await captureRejection(generateWithinBudget(agent, "Ringkas laporan.", REPORT_INTERPRETER_INSTRUCTIONS));
      assert.match(String((error as Error).message), new RegExp(GENERATION_TOKEN_BUDGET_MARKER));
      assert.equal(classifyJobError(error), "model_failed");
    });
  });

  describe("call sites", () => {
    it("interpretReport sends the bounded call options", async () => {
      const { agent, calls } = recordingAgent(INTERPRETER_JSON);
      const interpretation = await interpretReport(interpretInput("Banjir setinggi 40 cm merendam jalan."), { agent });

      assert.equal(interpretation.primaryCategory, "disasters_weather");
      assert.equal(calls.length, 1);
      const options = calls[0]?.options;
      assert.ok(options?.maxSteps !== undefined && options.maxSteps <= 4, "interpreter maxSteps <= 4");
      assert.ok(options?.abortSignal instanceof AbortSignal, "interpreter passes an abortSignal");
      assert.equal(options?.modelSettings?.maxOutputTokens, GENERATION_MAX_OUTPUT_TOKENS);
    });

    it("interpretReport refuses an oversized report before the model call", async () => {
      const { agent, calls } = recordingAgent(INTERPRETER_JSON);
      const oversized = "Banjir merendam jalan. ".repeat(Math.ceil(maxPromptCharsBeside(REPORT_INTERPRETER_INSTRUCTIONS) / 22) + 10);

      const error = await captureRejection(interpretReport(interpretInput(oversized), { agent }));
      assert.equal(calls.length, 0, "the interpreter never calls the model");
      assert.equal(classifyJobError(error), "model_failed");
    });

    it("correlateIncident sends the bounded call options", async () => {
      const { agent, calls } = recordingAgent(NEW_INCIDENT_JSON);
      const correlation = await correlateIncident(correlateInput("Banjir setinggi 40 cm merendam jalan."), { agent });

      assert.equal(correlation.decision, "new_incident");
      assert.equal(calls.length, 1);
      const options = calls[0]?.options;
      assert.ok(options?.maxSteps !== undefined && options.maxSteps <= 4, "correlator maxSteps <= 4");
      assert.ok(options?.abortSignal instanceof AbortSignal, "correlator passes an abortSignal");
      assert.equal(options?.modelSettings?.maxOutputTokens, GENERATION_MAX_OUTPUT_TOKENS);
    });

    it("correlateIncident refuses an oversized report before the model call", async () => {
      const { agent, calls } = recordingAgent(NEW_INCIDENT_JSON);
      const oversized = "a".repeat(maxPromptCharsBeside(INCIDENT_CORRELATOR_INSTRUCTIONS) + 1);

      const error = await captureRejection(correlateIncident(correlateInput(oversized), { agent }));
      assert.equal(calls.length, 0, "the correlator never calls the model");
      assert.equal(classifyJobError(error), "model_failed");
    });
  });

  describe("tool attempts (n/a for these agents)", () => {
    it("the live agents register no tools, so the 5-attempt tool cap has nothing to bound", async () => {
      const previous = process.env.NINEROUTER_MODE;
      process.env.NINEROUTER_MODE = "mock";
      try {
        for (const agent of [createReportInterpretationAgent(), createIncidentCorrelationAgent()]) {
          assert.deepEqual(Object.keys(await agent.listTools()), [], `${agent.name} has no tools`);
        }
      } finally {
        if (previous === undefined) delete process.env.NINEROUTER_MODE;
        else process.env.NINEROUTER_MODE = previous;
      }
    });
  });

  describe("real Mastra agent", () => {
    it("forwards the output cap to the model and makes one model call for a tool-free agent", async () => {
      const probe = probeModel("answer");
      const agent = probeAgent(probe.model);

      const response = await generateWithinBudget(agent, "Ringkas laporan singkat.", REPORT_INTERPRETER_INSTRUCTIONS);
      assert.equal(response.text, INTERPRETER_JSON);
      assert.equal(probe.calls.length, 1, "one model call: no tools, so no extra steps");
      assert.equal(probe.calls[0]?.maxOutputTokens, GENERATION_MAX_OUTPUT_TOKENS);
      assert.equal(probe.calls[0]?.hasAbortSignal, true, "the model call carries the budget signal");
    });

    it("cuts a hung provider call through Mastra at the time cap and classifies it as model_timeout", async () => {
      const probe = probeModel("hang");
      const agent = probeAgent(probe.model);
      const startedAt = Date.now();

      const error = await captureRejection(generateWithinBudget(agent, "Ringkas laporan.", REPORT_INTERPRETER_INSTRUCTIONS, 30));
      assert.ok(Date.now() - startedAt < SAFETY_MS, "the budget, not the safety stop, ended the call");
      assert.equal(classifyJobError(error), "model_timeout", `unexpected failure: ${String((error as Error).message)}`);
    });
  });

  describe("failure classification", () => {
    it("classifies a token-budget refusal as model_failed, also when a workflow wraps the message", () => {
      assert.equal(
        classifyJobError(new Error(`${GENERATION_TOKEN_BUDGET_MARKER} exceeded before the call: estimated input 9000 tokens`)),
        "model_failed",
      );
      assert.equal(
        classifyJobError(new Error(`Mastra workflow failed | ${GENERATION_TOKEN_BUDGET_MARKER} exceeded before the call`)),
        "model_failed",
      );
    });

    it("classifies the active-time cap message as model_timeout", () => {
      assert.equal(
        classifyJobError(new Error("NFR-02 model call timed out: active-time budget of 60000 ms reached")),
        "model_timeout",
      );
    });
  });
});
