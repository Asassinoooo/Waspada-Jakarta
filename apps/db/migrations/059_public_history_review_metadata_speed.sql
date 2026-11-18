-- HOSTED-38 (19 Nov 2026): speed up the public history review metadata view.
-- Migration 014 selected the latest decision for every decision row before
-- joining the history view, so the planner re-evaluated the history join per
-- decision row (39.7 s for the disclosure statement on the hosted database).
-- This version starts from the bounded history rows and looks up the latest
-- decision per exact version with LATERAL, using the existing
-- public_event_history_review_latest_idx from 014.
-- Semantics are unchanged: the latest decision by review_id for each exact
-- version is shown only when it is approved, and only for versions present in
-- public_event_history_versions. CREATE OR REPLACE keeps the grants from 014;
-- no grant is added or changed here.

CREATE OR REPLACE VIEW waspada.public_event_history_review_metadata
WITH (security_barrier = true)
AS
SELECT history.dataset_kind, history.event_id, history.version AS event_version,
       latest.review_status, latest.change_type, latest.summary,
       latest.reviewer_id, latest.reviewed_at
FROM waspada.public_event_history_versions AS history
CROSS JOIN LATERAL (
  SELECT decision.review_status, decision.change_type, decision.summary,
         decision.reviewer_id, decision.reviewed_at
  FROM waspada.public_event_history_review_decisions AS decision
  WHERE decision.dataset_kind = history.dataset_kind
    AND decision.event_id = history.event_id
    AND decision.event_version = history.version
  ORDER BY decision.review_id DESC
  LIMIT 1
) AS latest
WHERE latest.review_status = 'approved';
