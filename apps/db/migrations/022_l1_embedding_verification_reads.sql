-- L1 verifies a closed embedding retry against exact chunk, run, and stored-vector lineage.
-- Existing INSERT and status-only UPDATE grants stay unchanged.
GRANT SELECT (
  trace_id,
  capability,
  provider,
  model_version,
  dimensions,
  distance_metric,
  vector_index_version,
  input_text_hash,
  created_at
)
  ON waspada.embedding_runs
  TO waspada_l1_pipeline;

GRANT SELECT (dataset_kind, embedding_run_id, dimensions, embedding)
  ON waspada.embedding_vectors
  TO waspada_l1_pipeline;
