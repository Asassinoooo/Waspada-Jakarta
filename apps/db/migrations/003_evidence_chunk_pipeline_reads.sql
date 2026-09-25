GRANT SELECT (
  dataset_kind,
  chunk_id,
  report_revision_id,
  permitted_text_hash,
  span_start,
  span_end,
  offset_unit,
  chunker_version,
  chunk_text_hash,
  status
) ON TABLE waspada.evidence_chunks TO waspada_l1_pipeline;

GRANT SELECT (
  dataset_kind,
  embedding_run_id,
  chunk_id,
  status
) ON TABLE waspada.embedding_runs TO waspada_l1_pipeline;
