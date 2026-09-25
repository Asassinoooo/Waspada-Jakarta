-- GEO-STORE-CORE: only the L1 columns needed for exact support resolution and geometry retries.
GRANT SELECT (
  dataset_kind, evidence_ref_id, report_revision_id, permitted_text_hash,
  span_start, span_end, offset_unit, relation
) ON waspada.evidence_references TO waspada_l1_pipeline;

GRANT SELECT (
  dataset_kind, geometry_id, trace_id, role, shape, coordinate_reference_system,
  precision_m, precision_basis, display_label, record_json
) ON waspada.geometries TO waspada_l1_pipeline;

GRANT SELECT (
  dataset_kind, geometry_id, evidence_ref_id
) ON waspada.geometry_evidence TO waspada_l1_pipeline;
