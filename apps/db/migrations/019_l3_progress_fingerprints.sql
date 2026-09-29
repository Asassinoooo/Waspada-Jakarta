-- Pin the digest key identifier outside the schema 2.0 request record so its
-- public JSON shape and every historical request remain unchanged.
ALTER TABLE waspada.investigation_requests
  ADD COLUMN fingerprint_key_id text
    CHECK (fingerprint_key_id IS NULL OR fingerprint_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  ADD CONSTRAINT investigation_request_fingerprint_scope_unique
    UNIQUE (dataset_kind, investigation_id, fingerprint_key_id);

CREATE OR REPLACE FUNCTION waspada.guard_investigation_request_ledger_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'investigation requests cannot be deleted';
  END IF;

  IF ROW(
       NEW.dataset_kind, NEW.investigation_id, NEW.trace_id, NEW.candidate_id,
       NEW.context_id, NEW.event_id, NEW.event_version, NEW.questions,
       NEW.budget_policy_version, NEW.limit_tool_attempts, NEW.limit_reasoning_turns,
       NEW.limit_active_seconds, NEW.limit_model_tokens, NEW.requested_at,
       NEW.record_json, NEW.fingerprint_key_id
     ) IS DISTINCT FROM ROW(
       OLD.dataset_kind, OLD.investigation_id, OLD.trace_id, OLD.candidate_id,
       OLD.context_id, OLD.event_id, OLD.event_version, OLD.questions,
       OLD.budget_policy_version, OLD.limit_tool_attempts, OLD.limit_reasoning_turns,
       OLD.limit_active_seconds, OLD.limit_model_tokens, OLD.requested_at,
       OLD.record_json, OLD.fingerprint_key_id
     ) THEN
    RAISE EXCEPTION 'investigation request identity and configured limits are immutable';
  END IF;

  RETURN NEW;
END;
$$;

ALTER TABLE waspada.investigation_action_reservations
  ADD COLUMN action_fingerprint_key_id text,
  ADD COLUMN action_fingerprint bytea,
  ADD CONSTRAINT investigation_action_fingerprint_shape_check
    CHECK (
      (action_fingerprint_key_id IS NULL AND action_fingerprint IS NULL)
      OR
      (action_kind = 'tool'
        AND action_fingerprint_key_id IS NOT NULL
        AND action_fingerprint_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
        AND action_fingerprint IS NOT NULL
        AND octet_length(action_fingerprint) = 32)
      OR
      (action_kind = 'reasoning'
        AND action_fingerprint_key_id IS NULL
        AND action_fingerprint IS NULL)
    ) NOT VALID,
  ADD CONSTRAINT investigation_action_fingerprint_case_key_fk
    FOREIGN KEY (dataset_kind, investigation_id, action_fingerprint_key_id)
    REFERENCES waspada.investigation_requests (dataset_kind, investigation_id, fingerprint_key_id);

CREATE UNIQUE INDEX investigation_action_registered_fingerprint_once_idx
  ON waspada.investigation_action_reservations
    (dataset_kind, investigation_id, action_fingerprint_key_id, action_fingerprint)
  WHERE action_kind = 'tool' AND action_fingerprint IS NOT NULL;

CREATE OR REPLACE FUNCTION waspada.guard_investigation_action_reservation_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'investigation action reservations cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.action_kind = 'tool'
     AND (NEW.action_fingerprint_key_id IS NULL OR NEW.action_fingerprint IS NULL) THEN
    RAISE EXCEPTION 'registered tool reservations require a keyed fingerprint';
  END IF;

  IF ROW(
       NEW.dataset_kind, NEW.reservation_id, NEW.investigation_id, NEW.action_kind,
       NEW.action_name, NEW.expected_checkpoint_version, NEW.reserved_tool_attempts,
       NEW.reserved_reasoning_turns, NEW.reserved_active_seconds, NEW.reserved_model_tokens,
       NEW.created_at, NEW.action_fingerprint_key_id, NEW.action_fingerprint
     ) IS DISTINCT FROM ROW(
       OLD.dataset_kind, OLD.reservation_id, OLD.investigation_id, OLD.action_kind,
       OLD.action_name, OLD.expected_checkpoint_version, OLD.reserved_tool_attempts,
       OLD.reserved_reasoning_turns, OLD.reserved_active_seconds, OLD.reserved_model_tokens,
       OLD.created_at, OLD.action_fingerprint_key_id, OLD.action_fingerprint
     ) THEN
    RAISE EXCEPTION 'investigation action reservation identity and maximum usage are immutable';
  END IF;

  IF NOT (
    (OLD.reservation_status = 'reserved' AND NEW.reservation_status IN ('started', 'released'))
    OR (OLD.reservation_status = 'started' AND NEW.reservation_status = 'reconciled')
  ) THEN
    RAISE EXCEPTION 'invalid investigation action reservation transition';
  END IF;

  RETURN NEW;
END;
$$;

ALTER TABLE waspada.investigation_checkpoints
  ADD CONSTRAINT investigation_checkpoint_progress_scope_unique
    UNIQUE (dataset_kind, investigation_id, checkpoint_version, candidate_id, context_id);

CREATE TABLE waspada.investigation_progress_snapshots (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  investigation_id text NOT NULL,
  checkpoint_version integer NOT NULL CHECK (checkpoint_version > 0),
  candidate_id text NOT NULL,
  context_id text NOT NULL,
  fingerprint_key_id text NOT NULL CHECK (fingerprint_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  grounding_fingerprint bytea NOT NULL CHECK (octet_length(grounding_fingerprint) = 32),
  consecutive_no_progress smallint NOT NULL CHECK (consecutive_no_progress BETWEEN 0 AND 2),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (dataset_kind, investigation_id, checkpoint_version),
  FOREIGN KEY (dataset_kind, investigation_id, fingerprint_key_id)
    REFERENCES waspada.investigation_requests (dataset_kind, investigation_id, fingerprint_key_id),
  FOREIGN KEY (dataset_kind, investigation_id, checkpoint_version, candidate_id, context_id)
    REFERENCES waspada.investigation_checkpoints
      (dataset_kind, investigation_id, checkpoint_version, candidate_id, context_id),
  FOREIGN KEY (dataset_kind, context_id, candidate_id)
    REFERENCES waspada.grounding_contexts (dataset_kind, context_id, candidate_id)
);

CREATE FUNCTION waspada.guard_investigation_progress_snapshot_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'investigation progress snapshots are append-only';
END;
$$;

CREATE TRIGGER investigation_progress_snapshots_append_only
  BEFORE UPDATE OR DELETE ON waspada.investigation_progress_snapshots
  FOR EACH ROW EXECUTE FUNCTION waspada.guard_investigation_progress_snapshot_append_only();

GRANT SELECT (fingerprint_key_id)
  ON TABLE waspada.investigation_requests TO waspada_l3_coordinator;
GRANT INSERT (fingerprint_key_id)
  ON TABLE waspada.investigation_requests TO waspada_l3_coordinator;

GRANT SELECT (action_fingerprint_key_id, action_fingerprint)
  ON TABLE waspada.investigation_action_reservations TO waspada_l3_coordinator;
GRANT INSERT (action_fingerprint_key_id, action_fingerprint)
  ON TABLE waspada.investigation_action_reservations TO waspada_l3_coordinator;

GRANT SELECT (
    dataset_kind, investigation_id, checkpoint_version, candidate_id, context_id,
    fingerprint_key_id, grounding_fingerprint, consecutive_no_progress, recorded_at
  ) ON TABLE waspada.investigation_progress_snapshots TO waspada_l3_coordinator;
GRANT INSERT (
    dataset_kind, investigation_id, checkpoint_version, candidate_id, context_id,
    fingerprint_key_id, grounding_fingerprint, consecutive_no_progress, recorded_at
  ) ON TABLE waspada.investigation_progress_snapshots TO waspada_l3_coordinator;
