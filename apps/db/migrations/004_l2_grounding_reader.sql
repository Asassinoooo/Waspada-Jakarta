DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'waspada_l2_grounding_reader'
  ) THEN
    CREATE ROLE waspada_l2_grounding_reader NOLOGIN;
  END IF;
END;
$$;

ALTER ROLE waspada_l2_grounding_reader
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

GRANT USAGE ON SCHEMA waspada TO waspada_l2_grounding_reader;

GRANT SELECT (
  source_id,
  display_name,
  source_kind,
  publisher_group_id,
  registry_status,
  approval_status,
  health_status
) ON TABLE waspada.source_registry TO waspada_l2_grounding_reader;

GRANT SELECT (
  dataset_kind,
  report_revision_id,
  source_id,
  permitted_text_hash,
  permitted_text,
  published_at,
  observed_at,
  retrieved_at,
  valid_from,
  valid_until,
  revision_status
) ON TABLE waspada.report_revisions TO waspada_l2_grounding_reader;

GRANT SELECT (
  dataset_kind,
  evidence_ref_id,
  report_revision_id,
  permitted_text_hash,
  span_start,
  span_end,
  offset_unit,
  relation
) ON TABLE waspada.evidence_references TO waspada_l2_grounding_reader;

GRANT SELECT (
  dataset_kind,
  candidate_id,
  evidence_ref_id
) ON TABLE waspada.extraction_evidence TO waspada_l2_grounding_reader;

GRANT SELECT (
  dataset_kind,
  candidate_id,
  record_json
) ON TABLE waspada.extraction_results TO waspada_l2_grounding_reader;

GRANT SELECT (
  dataset_kind,
  geometry_id,
  role,
  shape,
  precision_m,
  precision_basis,
  display_label
) ON TABLE waspada.geometries TO waspada_l2_grounding_reader;

GRANT SELECT (
  dataset_kind,
  geometry_id,
  evidence_ref_id
) ON TABLE waspada.geometry_evidence TO waspada_l2_grounding_reader;

GRANT SELECT (
  dataset_kind,
  origin_id,
  origin_kind,
  source_id,
  lineage_relation,
  independence_status
) ON TABLE waspada.evidence_origins TO waspada_l2_grounding_reader;

GRANT SELECT (
  dataset_kind,
  origin_id,
  evidence_ref_id
) ON TABLE waspada.origin_evidence TO waspada_l2_grounding_reader;

GRANT SELECT (
  dataset_kind,
  origin_id,
  depends_on_origin_id
) ON TABLE waspada.origin_dependencies TO waspada_l2_grounding_reader;

GRANT SELECT (
  dataset_kind,
  chunk_id,
  report_revision_id,
  permitted_text_hash,
  span_start,
  span_end,
  chunker_version,
  chunk_text_hash,
  status
) ON TABLE waspada.evidence_chunks TO waspada_l2_grounding_reader;

GRANT SELECT (
  dataset_kind,
  embedding_run_id,
  chunk_id,
  capability,
  provider,
  model_version,
  dimensions,
  distance_metric,
  vector_index_version,
  input_text_hash,
  status,
  created_at
) ON TABLE waspada.embedding_runs TO waspada_l2_grounding_reader;

GRANT SELECT (
  dataset_kind,
  embedding_run_id,
  dimensions,
  embedding
) ON TABLE waspada.embedding_vectors TO waspada_l2_grounding_reader;
