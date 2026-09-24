import type {
  CapabilityOutcome,
  ClassificationRequest,
  EmbeddingRequest,
  ExtractionRequest,
  ModelAdapterConfiguration,
  ModelCapability,
  ModelCapabilityAdapter,
  ModelIdentity,
  ReasoningRequest,
  UntrustedModelProvider,
} from "./contracts.js";
import {
  ContractValidationError,
  parseClassificationOutput,
  parseEmbeddingOutput,
  parseExtractionOutput,
  parseReasoningOutput,
  validateClassificationRequest,
  validateEmbeddingRequest,
  validateExtractionRequest,
  validateReasoningRequest,
} from "./validation.js";

type RequestValidator<R> = (value: unknown) => Promise<R>;
type OutputParser<R, T> = (raw: unknown, request: R) => Promise<T>;

async function runCapability<C extends ModelCapability, R, T>(args: {
  readonly capability: C;
  readonly provider: UntrustedModelProvider | undefined;
  readonly configured: boolean;
  readonly request: unknown;
  readonly validateRequest: RequestValidator<R>;
  readonly invoke: (request: R) => Promise<unknown>;
  readonly parseOutput: OutputParser<R, T>;
}): Promise<CapabilityOutcome<T, C>> {
  if (!args.provider) {
    return { status: "not_configured", capability: args.capability, reason: "provider_not_configured" };
  }
  if (!args.configured) {
    return { status: "not_configured", capability: args.capability, reason: "capability_not_configured" };
  }

  let request: R;
  try {
    request = await args.validateRequest(args.request);
  } catch (error) {
    return {
      status: "invalid_request",
      capability: args.capability,
      reason: error instanceof ContractValidationError ? error.code : "request_validation_failed",
    };
  }

  let raw: unknown;
  try {
    raw = await args.invoke(request);
  } catch {
    return { status: "provider_error", capability: args.capability };
  }

  try {
    return { status: "succeeded", capability: args.capability, value: await args.parseOutput(raw, request) };
  } catch (error) {
    return {
      status: "invalid_output",
      capability: args.capability,
      reason: error instanceof ContractValidationError ? error.code : "output_validation_failed",
    };
  }
}

/**
 * Creates a validating boundary around an injected provider. Passing no
 * provider is an explicit unavailable state; no mock or empty success is used.
 */
export function createModelCapabilityAdapter(
  provider?: UntrustedModelProvider,
  configuration: ModelAdapterConfiguration = {},
): ModelCapabilityAdapter {
  return {
    classify(request: ClassificationRequest) {
      const identity = configuration.classification;
      return runCapability({
        capability: "classification",
        provider,
        configured: identity !== undefined,
        request,
        validateRequest: validateClassificationRequest,
        invoke: (validated) => provider!.classify(validated),
        parseOutput: (raw, validated) => parseClassificationOutput(raw, validated, identity as ModelIdentity),
      });
    },
    extract(request: ExtractionRequest) {
      const identity = configuration.extraction;
      return runCapability({
        capability: "extraction",
        provider,
        configured: identity !== undefined,
        request,
        validateRequest: validateExtractionRequest,
        invoke: (validated) => provider!.extract(validated),
        parseOutput: (raw, validated) => parseExtractionOutput(raw, validated, identity as ModelIdentity),
      });
    },
    embed(request: EmbeddingRequest) {
      const identity = configuration.embedding;
      return runCapability({
        capability: "embedding",
        provider,
        configured: identity !== undefined,
        request,
        validateRequest: validateEmbeddingRequest,
        invoke: (validated) => provider!.embed(validated),
        parseOutput: (raw, validated) => parseEmbeddingOutput(raw, validated, identity!),
      });
    },
    reason(request: ReasoningRequest) {
      const identity = configuration.reasoning;
      return runCapability({
        capability: "reasoning",
        provider,
        configured: identity !== undefined,
        request,
        validateRequest: validateReasoningRequest,
        invoke: (validated) => provider!.reason(validated),
        parseOutput: (raw, validated) => parseReasoningOutput(raw, validated, identity as ModelIdentity),
      });
    },
  };
}
