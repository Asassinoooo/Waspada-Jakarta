import type { Agent } from "@mastra/core/agent";

/**
 * NFR-02 resource bounds for the live intelligence agents (TEST-GAP-02 / T6).
 *
 * SDP NFR-02 caps L3 work at 5 tool attempts, 4 reasoning turns, 60 active seconds, or 12,000
 * model input and output tokens, whichever comes first. The report interpreter and the incident
 * correlator are single model calls that register no tools, so:
 * - reasoning turns: `maxSteps` is 4. With no tools a run is one model call.
 * - tool attempts: not applicable. The NFR-02 test asserts that these agents register no tools.
 * - active time: the call is aborted at 60 s, which surfaces as a model_timeout failure.
 * - tokens: the output is capped by `maxOutputTokens` (4,000). The input is estimated before the
 *   call as ceil(chars / 4), and a prompt is refused when that estimate plus the output cap would
 *   exceed 12,000. The estimate is coarse and is not checked against the provider's usage.
 *
 * A budget hit is a failure. job-runner.ts classifies it, and the job then takes its normal bounded
 * retry path. Nothing here retries, and the agents keep maxRetries 0.
 */
export const GENERATION_MAX_STEPS = 4;
export const GENERATION_MAX_TOOL_ATTEMPTS = 5;
export const GENERATION_MAX_ACTIVE_MS = 60_000;
export const GENERATION_MAX_TOKENS = 12_000;
export const GENERATION_MAX_OUTPUT_TOKENS = 4_000;
export const GENERATION_MAX_INPUT_TOKENS = GENERATION_MAX_TOKENS - GENERATION_MAX_OUTPUT_TOKENS;
/** Stable text that classifyJobError maps to model_failed. Errors can be wrapped, so match the text. */
export const GENERATION_TOKEN_BUDGET_MARKER = "NFR-02 model token budget";

export class GenerationBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationBudgetError";
  }
}

/** ceil(chars / 4). A coarse estimate for the pre-call guard, not a tokenizer. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Refuses a prompt before any model call when its estimated input (instructions plus prompt)
 * would leave less room than the output cap needs inside GENERATION_MAX_TOKENS.
 * Returns the estimated input tokens when the prompt fits.
 */
export function assertPromptWithinInputBudget(instructions: string, prompt: string): number {
  const estimatedInput = estimateTokens(instructions) + estimateTokens(prompt);
  if (estimatedInput > GENERATION_MAX_INPUT_TOKENS) {
    throw new GenerationBudgetError(
      `${GENERATION_TOKEN_BUDGET_MARKER} exceeded before the call: estimated input ${estimatedInput} tokens, ` +
        `allowance ${GENERATION_MAX_INPUT_TOKENS} beside the ${GENERATION_MAX_OUTPUT_TOKENS}-token output cap ` +
        `(total ${GENERATION_MAX_TOKENS})`,
    );
  }
  return estimatedInput;
}

export interface GenerationBudget {
  /** Aborts when the active-time budget runs out. Passed to the model call as its abortSignal. */
  readonly signal: AbortSignal;
  /** Clears the timer once the call settles, so a finished call is never aborted later. */
  dispose(): void;
}

function activeTimeExhausted(activeMs: number): GenerationBudgetError {
  return new GenerationBudgetError(`NFR-02 model call timed out: active-time budget of ${activeMs} ms reached`);
}

export function startGenerationBudget(activeMs: number = GENERATION_MAX_ACTIVE_MS): GenerationBudget {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(activeTimeExhausted(activeMs));
  }, activeMs);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

/**
 * The one entry point for a live agent call. It applies the pre-call input guard, the 4-step cap,
 * the 60 s abort and the output cap, then clears the timer. Every failure propagates to the caller,
 * which classifies it. Nothing here retries.
 *
 * Mastra resolves an aborted call instead of rejecting it (finishReason "aborted", empty text), and a
 * call that stops at the output cap resolves with finishReason "length" (truncated text). Both are
 * budget hits, so neither can reach the JSON parser as an ordinary answer.
 */
export async function generateWithinBudget(
  agent: Agent,
  prompt: string,
  instructions: string,
  activeMs: number = GENERATION_MAX_ACTIVE_MS,
): Promise<{ readonly text: string }> {
  assertPromptWithinInputBudget(instructions, prompt);
  const budget = startGenerationBudget(activeMs);
  try {
    const response = await agent.generate(prompt, {
      maxSteps: GENERATION_MAX_STEPS,
      abortSignal: budget.signal,
      modelSettings: { maxOutputTokens: GENERATION_MAX_OUTPUT_TOKENS },
    });
    const finishReason: string | undefined = response.finishReason;
    if (finishReason === "aborted") {
      throw activeTimeExhausted(activeMs);
    }
    if (finishReason === "length") {
      throw new GenerationBudgetError(
        `${GENERATION_TOKEN_BUDGET_MARKER} exceeded: the output reached the ${GENERATION_MAX_OUTPUT_TOKENS}-token output cap`,
      );
    }
    return response;
  } finally {
    budget.dispose();
  }
}
