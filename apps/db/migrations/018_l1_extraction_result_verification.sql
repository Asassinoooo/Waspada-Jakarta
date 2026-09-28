-- L1 needs these exact extraction columns to verify an append-only retry.
-- Keep its existing INSERT grants and avoid granting UPDATE/DELETE or table-wide SELECT.
REVOKE SELECT ON TABLE waspada.extraction_results, waspada.extraction_evidence
  FROM waspada_l1_pipeline;
REVOKE SELECT (
  dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json
) ON TABLE waspada.extraction_results FROM waspada_l1_pipeline;
REVOKE SELECT (
  dataset_kind, candidate_id, evidence_ref_id
) ON TABLE waspada.extraction_evidence FROM waspada_l1_pipeline;

GRANT SELECT (
  dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json
) ON TABLE waspada.extraction_results TO waspada_l1_pipeline;

GRANT SELECT (
  dataset_kind, candidate_id, evidence_ref_id
) ON TABLE waspada.extraction_evidence TO waspada_l1_pipeline;