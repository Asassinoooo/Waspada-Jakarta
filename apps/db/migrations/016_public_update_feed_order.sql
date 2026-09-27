-- API-PUBLIC-UPDATES-READER-CORE: assign feed positions transactionally.
-- Existing rows receive a deterministic baseline order only; their historical
-- commit order cannot be reconstructed from the old schema. All new decisions
-- use the singleton row lock below, never review_id or reviewed_at as a cursor.

ALTER TABLE waspada.public_event_history_review_decisions
  ADD COLUMN change_sequence bigint;

-- The migration's transactional schema owner temporarily bypasses the
-- append-only row trigger only to backfill this new system-managed column.
ALTER TABLE waspada.public_event_history_review_decisions
  DISABLE TRIGGER public_event_history_review_decisions_append_only;

WITH ranked_decisions AS (
  SELECT review_id,
         row_number() OVER (ORDER BY review_id) AS assigned_sequence
  FROM waspada.public_event_history_review_decisions
)
UPDATE waspada.public_event_history_review_decisions AS decision
SET change_sequence = ranked_decisions.assigned_sequence
FROM ranked_decisions
WHERE ranked_decisions.review_id = decision.review_id;

ALTER TABLE waspada.public_event_history_review_decisions
  ENABLE TRIGGER public_event_history_review_decisions_append_only;

ALTER TABLE waspada.public_event_history_review_decisions
  ALTER COLUMN change_sequence SET NOT NULL,
  ADD CONSTRAINT public_event_history_review_change_sequence_check
    CHECK (change_sequence > 0);

CREATE UNIQUE INDEX public_event_history_review_change_sequence_idx
  ON waspada.public_event_history_review_decisions (change_sequence);

CREATE INDEX public_event_history_review_sequence_latest_idx
  ON waspada.public_event_history_review_decisions
    (dataset_kind, event_id, event_version, change_sequence DESC);

CREATE TABLE waspada.public_event_updates_counter (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  change_sequence bigint NOT NULL CHECK (change_sequence >= 0)
);

INSERT INTO waspada.public_event_updates_counter (singleton, change_sequence)
SELECT true, COALESCE(MAX(change_sequence), 0)
FROM waspada.public_event_history_review_decisions;

CREATE FUNCTION waspada.assign_public_event_update_sequence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, waspada
AS $function$
DECLARE
  assigned_sequence bigint;
BEGIN
  UPDATE waspada.public_event_updates_counter
  SET change_sequence = change_sequence + 1
  WHERE singleton = true
  RETURNING change_sequence INTO assigned_sequence;

  IF assigned_sequence IS NULL THEN
    RAISE EXCEPTION 'public event update sequence state is unavailable'
      USING ERRCODE = '55000';
  END IF;

  NEW.change_sequence := assigned_sequence;
  RETURN NEW;
END;
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION waspada.assign_public_event_update_sequence()
FROM PUBLIC, waspada_public_reader, waspada_l1_pipeline,
  waspada_l2_grounding_reader, waspada_l2_grounding_writer,
  waspada_l3_coordinator, waspada_l4_publication_writer;

CREATE TRIGGER public_event_history_review_assign_update_sequence
  BEFORE INSERT ON waspada.public_event_history_review_decisions
  FOR EACH ROW EXECUTE FUNCTION waspada.assign_public_event_update_sequence();

CREATE VIEW waspada.public_event_updates_watermark
WITH (security_barrier = true)
AS
SELECT change_sequence AS through_sequence
FROM waspada.public_event_updates_counter
WHERE singleton = true;

-- Pick the latest decision across every status before filtering to approved.
-- The existing history view is the final withdrawal and current-public gate.
CREATE VIEW waspada.public_event_updates_candidates
WITH (security_barrier = true)
AS
WITH latest_review AS (
  SELECT DISTINCT ON (decision.dataset_kind, decision.event_id, decision.event_version)
         decision.dataset_kind, decision.event_id, decision.event_version,
         decision.review_status, decision.change_type, decision.summary,
         decision.change_sequence
  FROM waspada.public_event_history_review_decisions AS decision
  ORDER BY decision.dataset_kind, decision.event_id, decision.event_version,
           decision.change_sequence DESC
)
SELECT latest.dataset_kind, latest.event_id, latest.event_version,
       latest.change_sequence, latest.change_type, latest.summary,
       history.record_json->>'published_at' AS published_at
FROM latest_review AS latest
JOIN waspada.public_event_history_versions AS history
  ON history.dataset_kind = latest.dataset_kind
 AND history.event_id = latest.event_id
 AND history.version = latest.event_version
WHERE latest.review_status = 'approved';

-- Counter state and raw decisions remain private. The update-specific views
-- deliberately omit moderator identifiers and grant only their safe rows.
REVOKE ALL PRIVILEGES ON TABLE
  waspada.public_event_history_review_decisions,
  waspada.public_event_updates_counter
FROM PUBLIC, waspada_public_reader, waspada_l1_pipeline,
  waspada_l2_grounding_reader, waspada_l2_grounding_writer,
  waspada_l3_coordinator, waspada_l4_publication_writer;

REVOKE ALL PRIVILEGES ON TABLE
  waspada.public_event_updates_watermark,
  waspada.public_event_updates_candidates
FROM PUBLIC, waspada_public_reader, waspada_l1_pipeline,
  waspada_l2_grounding_reader, waspada_l2_grounding_writer,
  waspada_l3_coordinator, waspada_l4_publication_writer;

GRANT SELECT ON TABLE waspada.public_event_updates_watermark,
  waspada.public_event_updates_candidates
TO waspada_public_reader;
