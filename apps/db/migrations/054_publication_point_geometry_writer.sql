-- HOSTED-26 (owner decision, 18 Nov 2026): a published agent or source event with a usable coordinate gets one Point
-- geometry (role approximate_place, precision_m NULL). Points only: no radius, polygon or line is ever written. The
-- publication transaction writes the geometry row, its evidence links and each claim's geometry link in one transaction,
-- under a savepoint, through persistGeometryInCallerTransaction (apps/db/src/geometry-writer.ts).
--
-- Both publication roles already hold SELECT on (dataset_kind, geometry_id) and on geometry_evidence, and INSERT on
-- event_claim_geometries. This migration adds only what the point write needs:
--   * INSERT on the geometries columns the writer names. The append-only trigger still refuses UPDATE and DELETE.
--   * INSERT on the geometry_evidence columns the writer names.
--   * SELECT on the geometries columns the writer's existence check compares. The check reads every one of them,
--     including shape and record_json, so all are granted.
-- The roles still cannot read report_revisions.permitted_text or its hash (migration 053 stands), and no whole-table
-- privilege is granted. Both roles get the same grant, because the moderator path runs the same publish transaction.
GRANT INSERT (
  dataset_kind, geometry_id, trace_id, role, shape, coordinate_reference_system,
  precision_m, precision_basis, display_label, record_json
) ON TABLE waspada.geometries
  TO waspada_l4_publication_writer, waspada_l4_moderator_publication_writer;

GRANT SELECT (
  trace_id, role, shape, coordinate_reference_system,
  precision_m, precision_basis, display_label, record_json
) ON TABLE waspada.geometries
  TO waspada_l4_publication_writer, waspada_l4_moderator_publication_writer;

GRANT INSERT (dataset_kind, geometry_id, evidence_ref_id)
  ON TABLE waspada.geometry_evidence
  TO waspada_l4_publication_writer, waspada_l4_moderator_publication_writer;
