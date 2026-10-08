CREATE TABLE waspada.investigation_advance_review_pending (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  investigation_id text NOT NULL,
  observed_checkpoint_version integer NOT NULL CHECK (observed_checkpoint_version > 0),
  stage text NOT NULL CHECK (stage IN ('planning', 'action', 'refresh', 'progress')),
  reason text NOT NULL CHECK (reason IN (
    'planner_replayed', 'planner_result_uncertain', 'invalid_action_timestamp',
    'action_replayed', 'action_result_uncertain', 'invalid_action_result',
    'refresh_failed', 'invalid_refreshed_context', 'progress_uncertain'
  )),
  reservation_id text CHECK (reservation_id IS NULL OR reservation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  marked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (dataset_kind, investigation_id),
  FOREIGN KEY (dataset_kind, investigation_id)
    REFERENCES waspada.investigation_requests (dataset_kind, investigation_id),
  CHECK (
    (stage = 'planning' AND reason IN (
      'planner_replayed', 'planner_result_uncertain', 'invalid_action_timestamp'
    ))
    OR (stage = 'action' AND reason IN (
      'action_replayed', 'action_result_uncertain', 'invalid_action_result'
    ))
    OR (stage = 'refresh' AND reason IN ('refresh_failed', 'invalid_refreshed_context'))
    OR (stage = 'progress' AND reason = 'progress_uncertain')
  )
);

CREATE UNIQUE INDEX investigation_action_reservations_case_reservation_key
  ON waspada.investigation_action_reservations (dataset_kind, investigation_id, reservation_id);

ALTER TABLE waspada.investigation_advance_review_pending
  ADD CONSTRAINT investigation_advance_review_pending_reservation_fk
  FOREIGN KEY (dataset_kind, investigation_id, reservation_id)
  REFERENCES waspada.investigation_action_reservations (dataset_kind, investigation_id, reservation_id);

CREATE FUNCTION waspada.guard_investigation_advance_review_pending_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'L3 advance review-pending markers are append-only';
END;
$$;

CREATE TRIGGER investigation_advance_review_pending_append_only
  BEFORE UPDATE OR DELETE ON waspada.investigation_advance_review_pending
  FOR EACH ROW EXECUTE FUNCTION waspada.guard_investigation_advance_review_pending_append_only();

REVOKE ALL PRIVILEGES ON TABLE waspada.investigation_advance_review_pending
  FROM PUBLIC, waspada_public_reader, waspada_l1_pipeline,
    waspada_l2_grounding_reader, waspada_l2_grounding_writer,
    waspada_l3_coordinator, waspada_l4_publication_writer;

GRANT SELECT (
  dataset_kind, investigation_id, observed_checkpoint_version,
  stage, reason, reservation_id, marked_at
) ON TABLE waspada.investigation_advance_review_pending TO waspada_l3_coordinator;

GRANT INSERT (
  dataset_kind, investigation_id, observed_checkpoint_version,
  stage, reason, reservation_id
) ON TABLE waspada.investigation_advance_review_pending TO waspada_l3_coordinator;
