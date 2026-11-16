-- HOSTED-15: the publication transaction writes one evidence origin per registered source of a published claim, and
-- links each origin to the persisted evidence the version cites. Origin rows are L4 publication output, so the
-- publication role may insert them. Only INSERT on the columns the writer sets is granted. The writer uses
-- ON CONFLICT DO NOTHING and never reads these rows back. Both tables stay append-only: the existing triggers refuse
-- UPDATE and DELETE.
GRANT INSERT (
  dataset_kind, origin_id, trace_id, origin_kind, actor_label, source_id,
  lineage_relation, independence_status, record_json
) ON TABLE waspada.evidence_origins TO waspada_l4_publication_writer;

GRANT INSERT (dataset_kind, origin_id, evidence_ref_id)
  ON TABLE waspada.origin_evidence TO waspada_l4_publication_writer;
