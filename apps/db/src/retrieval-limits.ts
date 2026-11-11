// INTEL-02: one retrieval policy for evidence and candidate lookups. The reference rule is the
// local pipeline's (tools/local-pipeline/processor.ts): scan at most 16 rows, return at most 8,
// and fail closed when nothing qualifies. Callers that get no candidates take their deterministic
// path (intelligence: no candidates means no correlation model call). The hard upper bounds in
// evidence-retrieval.ts still apply to explicit caller values.
export const RETRIEVAL_MAX_ROWS_EXAMINED = 16;
export const RETRIEVAL_MAX_RESULTS = 8;
