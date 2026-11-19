-- 060_public_source_attribution_retrieved_at.sql
-- POLISH-02 Part 1 (F-29, owner-approved 19 Nov 2026): the public event detail shows the source collection time
-- ("waktu pengumpulan"). The public API never sent it, so every event read "Tidak disebutkan". This migration adds
-- retrieved_at to the public attribution view as its LAST column. Postgres allows only appended columns in
-- CREATE OR REPLACE VIEW, and the existing columns keep their names, order and types.
-- The value is report_revisions.retrieved_at for the revision the evidence reference already points to. It is the
-- acquisition time of that revision, not the issuer, publication or processing time, and it is never invented.
-- The join is on the primary key (dataset_kind, report_revision_id), so it cannot add or drop rows. The view is
-- evaluated with its owner's privileges, as in 011, so no grant on report_revisions is added for the reader.
-- The reader keeps the SELECT grant from 011. CREATE OR REPLACE keeps that grant; no grant is added or changed here.

CREATE OR REPLACE VIEW waspada.public_source_attributions WITH (security_barrier = true) AS
WITH latest AS (
  SELECT DISTINCT ON (dataset_kind, evidence_ref_id)
         dataset_kind, evidence_ref_id, review_version, decision_status,
         public_display_name, source_url, source_published_at, source_observed_at
  FROM waspada.public_attribution_review_decisions
  ORDER BY dataset_kind, evidence_ref_id, review_version DESC
)
SELECT latest.dataset_kind,
       evidence.report_revision_id,
       evidence.permitted_text_hash,
       evidence.span_start,
       evidence.span_end,
       evidence.offset_unit,
       evidence.relation,
       true AS public_use_approved,
       latest.public_display_name AS display_name,
       latest.source_url AS url,
       CASE WHEN latest.source_published_at IS NULL THEN NULL
         ELSE to_char(latest.source_published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
       END AS published_at,
       CASE WHEN latest.source_observed_at IS NULL THEN NULL
         ELSE to_char(latest.source_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
       END AS observed_at,
       false AS excerpt_public_use_approved,
       NULL::text AS excerpt,
       to_char(revision.retrieved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS retrieved_at
FROM latest
JOIN waspada.evidence_references AS evidence
  ON evidence.dataset_kind = latest.dataset_kind
 AND evidence.evidence_ref_id = latest.evidence_ref_id
JOIN waspada.report_revisions AS revision
  ON revision.dataset_kind = evidence.dataset_kind
 AND revision.report_revision_id = evidence.report_revision_id
WHERE latest.decision_status = 'approved';
