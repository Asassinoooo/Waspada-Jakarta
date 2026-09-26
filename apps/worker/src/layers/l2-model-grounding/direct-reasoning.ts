import type { GroundingContextRecord } from "../../../../db/src/grounding-contexts.js";
import type {
  CapabilityOutcome,
  ModelCapabilityAdapter,
  ReasoningRequest,
  ReasoningResult,
} from "./contracts.js";
import type { ReasoningContextPersister } from "./context-persistence.js";
import {
  L2_DIRECT_REASONING_EVENT_NAME,
  noOpTelemetry,
  type L2DirectReasoningOutcome,
  type TelemetrySink,
} from "../l5-evaluation-monitoring/telemetry.js";

export interface InvestigationRequiredOutcome {
  readonly status: "investigation_required";
  readonly reasoningRequest: ReasoningRequest;
  readonly persistedRecord: GroundingContextRecord;
}

/** The adapter's exact typed outcome passes through unchanged on the direct path. */
export type DirectReasoningOutcome =
  | InvestigationRequiredOutcome
  | CapabilityOutcome<ReasoningResult, "reasoning">;

export interface DirectReasoningService {
  reason(request: unknown): Promise<DirectReasoningOutcome>;
}

/**
 * Persists the validated, refs-only context before deciding whether the direct
 * reasoning capability may run. Sufficiency remains caller-owned input.
 */
export function createDirectReasoningService(
  contextPersister: ReasoningContextPersister,
  modelCapabilityAdapter: Pick<ModelCapabilityAdapter, "reason">,
  telemetry: TelemetrySink = noOpTelemetry,
): DirectReasoningService {
  return {
    async reason(request: unknown): Promise<DirectReasoningOutcome> {
      const startedAt = Date.now();
      try {
        const persisted = await contextPersister.persist(request);
        if (!persisted.reasoningRequest.data.groundingContext.sufficient) {
          const outcome: InvestigationRequiredOutcome = {
            status: "investigation_required",
            reasoningRequest: persisted.reasoningRequest,
            persistedRecord: persisted.persistedRecord,
          };
          recordOutcome(telemetry, "investigation_required", startedAt);
          return outcome;
        }

        const outcome = await modelCapabilityAdapter.reason(persisted.reasoningRequest);
        recordOutcome(telemetry, capabilityOutcomeForTelemetry(outcome.status), startedAt);
        return outcome;
      } catch (error) {
        recordOutcome(telemetry, "error", startedAt);
        throw error;
      }
    },
  };
}

function capabilityOutcomeForTelemetry(status: string): L2DirectReasoningOutcome {
  switch (status) {
    case "succeeded":
    case "not_configured":
    case "invalid_request":
    case "invalid_output":
    case "provider_error":
      return status;
    default:
      return "error";
  }
}

function recordOutcome(
  telemetry: TelemetrySink,
  outcome: L2DirectReasoningOutcome,
  startedAt: number,
): void {
  const elapsed = Date.now() - startedAt;
  const durationMs = Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
  try {
    telemetry.record({
      eventName: L2_DIRECT_REASONING_EVENT_NAME,
      outcome,
      durationMs,
    });
  } catch {
    // Telemetry is best effort and cannot replace a service result or error.
  }
}
