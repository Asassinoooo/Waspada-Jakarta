-- 061_public_event_updates_automatic.sql
-- POLISH-02 Part 2 (owner-approved 19 Nov 2026): an automatic refresh by agent:auto-publisher is written as change_type
-- 'corrected'. The public updates feed showed it as "Versi dikoreksi", the same label as a moderator correction.
-- This migration appends one boolean, automatic, as the LAST column of the public updates candidate view. It is true
-- only when the latest approved decision is 'corrected' and its reviewer is exactly 'agent:auto-publisher'.
-- The reviewer identifier stays inside the database: the view exposes the boolean and never the identifier, as before.
-- Every other column, its order and its type are unchanged. CREATE OR REPLACE keeps the SELECT
-- grant to waspada_public_reader from 016; no grant is added or changed here.
-- The worker copies automatic onto the HistoryEntry of the updates feed only when it is true.

CREATE OR REPLACE VIEW waspada.public_event_updates_candidates
WITH (security_barrier = true)
AS
WITH latest_review AS (
  SELECT DISTINCT ON (decision.dataset_kind, decision.event_id, decision.event_version)
         decision.dataset_kind, decision.event_id, decision.event_version,
         decision.review_status, decision.change_type, decision.summary,
         decision.reviewer_id, decision.change_sequence
  FROM waspada.public_event_history_review_decisions AS decision
  ORDER BY decision.dataset_kind, decision.event_id, decision.event_version,
           decision.change_sequence DESC
)
SELECT latest.dataset_kind, latest.event_id, latest.event_version,
       latest.change_sequence, latest.change_type, latest.summary,
       history.record_json->>'published_at' AS published_at,
       (latest.change_type = 'corrected' AND latest.reviewer_id = 'agent:auto-publisher') AS automatic
FROM latest_review AS latest
JOIN waspada.public_event_history_versions AS history
  ON history.dataset_kind = latest.dataset_kind
 AND history.event_id = latest.event_id
 AND history.version = latest.event_version
WHERE latest.review_status = 'approved';
