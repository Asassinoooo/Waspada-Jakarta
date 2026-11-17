-- HOSTED-22 (owner decision, 16-17 Nov 2026): approving a source grants public display of its attribution. The publication
-- transaction writes one approved public_attribution_review_decisions row per supporting evidence reference whose source
-- passes the public-display rights check and is approved in source_registry. The writer may only INSERT the columns it
-- sets. It uses a bare ON CONFLICT DO NOTHING, so it needs no read grant on the table, and it never reads these rows back.
-- The table stays append-only: the existing triggers still refuse UPDATE, DELETE and TRUNCATE. review_decision_id is text
-- and no column uses a sequence, so no USAGE grant is needed.
GRANT INSERT (
  review_decision_id, dataset_kind, evidence_ref_id, report_revision_id, permitted_text_hash,
  span_start, span_end, offset_unit, relation, review_version, decision_status, rights_basis_ref,
  public_display_name, source_url, source_published_at, source_observed_at, reviewer_id,
  decision_reason, reviewed_at
) ON TABLE waspada.public_attribution_review_decisions TO waspada_l4_publication_writer;

-- The attribution takes the revision's own source, canonical article URL and publish time. Migration 005 removed the
-- publication role's whole-table reads of report_revisions. These five columns are granted back by column only. The
-- permitted text, its hash and the record stay unreadable to the role (publication-writer.test.ts asserts this).
GRANT SELECT (dataset_kind, report_revision_id, source_id, canonical_url, published_at)
  ON TABLE waspada.report_revisions TO waspada_l4_publication_writer;
