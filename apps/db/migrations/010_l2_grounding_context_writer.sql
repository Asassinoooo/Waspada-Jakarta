DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'waspada_l2_grounding_writer'
  ) THEN
    CREATE ROLE waspada_l2_grounding_writer NOLOGIN;
  END IF;
END;
$$;

ALTER ROLE waspada_l2_grounding_writer
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- Clamp a pre-existing local role to this migration's documented boundary.
REVOKE ALL PRIVILEGES ON SCHEMA waspada FROM waspada_l2_grounding_writer;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA waspada FROM waspada_l2_grounding_writer;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA waspada FROM waspada_l2_grounding_writer;

GRANT USAGE ON SCHEMA waspada TO waspada_l2_grounding_writer;

GRANT SELECT (
  dataset_kind,
  evidence_ref_id,
  report_revision_id,
  permitted_text_hash,
  span_start,
  span_end,
  offset_unit,
  relation
) ON TABLE waspada.evidence_references TO waspada_l2_grounding_writer;

GRANT SELECT (
  dataset_kind,
  event_id,
  version
) ON TABLE waspada.event_versions TO waspada_l2_grounding_writer;

GRANT SELECT (
  dataset_kind,
  decision_id
) ON TABLE waspada.publication_decisions TO waspada_l2_grounding_writer;

GRANT SELECT (
  dataset_kind,
  context_id,
  trace_id,
  candidate_id,
  retrieval_version,
  index_version,
  sufficient,
  record_json
) ON TABLE waspada.grounding_contexts TO waspada_l2_grounding_writer;

GRANT INSERT (
  dataset_kind,
  context_id,
  trace_id,
  candidate_id,
  retrieval_version,
  index_version,
  sufficient,
  record_json
) ON TABLE waspada.grounding_contexts TO waspada_l2_grounding_writer;

GRANT SELECT (dataset_kind, context_id, evidence_ref_id),
      INSERT (dataset_kind, context_id, evidence_ref_id)
  ON TABLE waspada.grounding_evidence TO waspada_l2_grounding_writer;

GRANT SELECT (dataset_kind, context_id, event_id, event_version),
      INSERT (dataset_kind, context_id, event_id, event_version)
  ON TABLE waspada.grounding_candidate_events TO waspada_l2_grounding_writer;

GRANT SELECT (dataset_kind, context_id, decision_id),
      INSERT (dataset_kind, context_id, decision_id)
  ON TABLE waspada.grounding_prior_decisions TO waspada_l2_grounding_writer;
