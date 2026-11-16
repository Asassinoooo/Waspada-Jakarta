import { extractJsonFromText } from "../providers/ninerouter-adapter.js";

/** Fixed codes for model output that cannot be used. Each one is also a classifyJobError keyword (json, schema). */
export type ModelOutputErrorCode = "agent_output_json_invalid" | "agent_output_schema_invalid";

/**
 * A model answer that cannot be used. The message is the code and nothing else. The answer itself is never
 * put in the error: a JSON syntax error quotes its input, and a schema error can echo received values. Both
 * are model text, and model text can repeat source text. No `cause` is attached, because a logged cause
 * would print the original message.
 */
export class ModelOutputError extends Error {
  readonly code: ModelOutputErrorCode;

  constructor(code: ModelOutputErrorCode) {
    super(code);
    this.name = "ModelOutputError";
    this.code = code;
  }
}

/** The part of a Zod schema that this parser uses. Structural, so any Zod version fits. */
export interface SafeParseable<Output> {
  safeParse(input: unknown): { success: true; data: Output } | { success: false };
}

/**
 * Parses a model answer with its schema. A JSON syntax error and a schema mismatch both become a
 * ModelOutputError with a fixed code. Schema issue details are dropped on purpose, so nothing from the answer
 * reaches a log.
 */
export function parseModelOutput<Output>(text: string, schema: SafeParseable<Output>): Output {
  let json: unknown;
  try {
    json = extractJsonFromText(text);
  } catch {
    throw new ModelOutputError("agent_output_json_invalid");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ModelOutputError("agent_output_schema_invalid");
  return parsed.data;
}
