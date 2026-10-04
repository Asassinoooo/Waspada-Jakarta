-- Layer 4 reads only the observation metadata needed for review candidates.
GRANT SELECT (
  dataset_kind, observation_id, target_report_revision_id,
  assertion_report_revision_id, asserted_state, replacement_report_revision_id,
  publisher_observed_at, retrieved_at, recorded_at
)
ON TABLE waspada.report_revision_source_observations
TO waspada_l4_report_revision_impact_reader;
