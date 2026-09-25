-- Keep the original grounding context on the request while allowing later
-- append-only checkpoint snapshots to point at refreshed L2 context.
ALTER TABLE waspada.investigation_requests
  ADD CONSTRAINT investigation_request_case_candidate_identity_unique
  UNIQUE (dataset_kind, investigation_id, candidate_id);

DO $$
DECLARE
  old_constraint record;
BEGIN
  FOR old_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'waspada.investigation_checkpoints'::regclass
      AND confrelid = 'waspada.investigation_requests'::regclass
      AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE
        'FOREIGN KEY (dataset_kind, investigation_id, candidate_id, context_id)%'
  LOOP
    EXECUTE format('ALTER TABLE waspada.investigation_checkpoints DROP CONSTRAINT %I', old_constraint.conname);
  END LOOP;
END;
$$;

ALTER TABLE waspada.investigation_checkpoints
  ADD CONSTRAINT checkpoint_investigation_candidate_identity_fk
  FOREIGN KEY (dataset_kind, investigation_id, candidate_id)
  REFERENCES waspada.investigation_requests (dataset_kind, investigation_id, candidate_id);

-- The request is immutable except for its aggregate budget counters. The
-- original append-only trigger is replaced by a guard that enforces this at
-- the database boundary as well as through column grants below.
DROP TRIGGER investigation_requests_append_only ON waspada.investigation_requests;

CREATE FUNCTION waspada.guard_investigation_request_ledger_update()
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
       NEW.limit_active_seconds, NEW.limit_model_tokens, NEW.requested_at, NEW.record_json
     ) IS DISTINCT FROM ROW(
       OLD.dataset_kind, OLD.investigation_id, OLD.trace_id, OLD.candidate_id,
       OLD.context_id, OLD.event_id, OLD.event_version, OLD.questions,
       OLD.budget_policy_version, OLD.limit_tool_attempts, OLD.limit_reasoning_turns,
       OLD.limit_active_seconds, OLD.limit_model_tokens, OLD.requested_at, OLD.record_json
     ) THEN
    RAISE EXCEPTION 'investigation request identity and configured limits are immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER investigation_requests_ledger_guard
  BEFORE UPDATE OR DELETE ON waspada.investigation_requests
  FOR EACH ROW EXECUTE FUNCTION waspada.guard_investigation_request_ledger_update();

CREATE TABLE waspada.investigation_action_reservations (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  reservation_id text NOT NULL CHECK (reservation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  investigation_id text NOT NULL,
  action_kind text NOT NULL CHECK (action_kind IN ('tool', 'reasoning')),
  action_name text NOT NULL CHECK (action_name ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
  expected_checkpoint_version integer NOT NULL CHECK (expected_checkpoint_version > 0),
  reserved_tool_attempts smallint NOT NULL CHECK (reserved_tool_attempts BETWEEN 0 AND 1),
  reserved_reasoning_turns smallint NOT NULL CHECK (reserved_reasoning_turns BETWEEN 0 AND 1),
  reserved_active_seconds integer NOT NULL CHECK (reserved_active_seconds BETWEEN 1 AND 60),
  reserved_model_tokens integer NOT NULL CHECK (reserved_model_tokens BETWEEN 0 AND 12000),
  reservation_status text NOT NULL CHECK (reservation_status IN ('reserved', 'started', 'reconciled', 'released')),
  outcome text CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'timed_out', 'denied', 'cancelled')),
  actual_active_seconds integer NOT NULL DEFAULT 0 CHECK (actual_active_seconds >= 0),
  actual_model_tokens integer NOT NULL DEFAULT 0 CHECK (actual_model_tokens >= 0),
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  reconciled_checkpoint_version integer,
  PRIMARY KEY (dataset_kind, reservation_id),
  FOREIGN KEY (dataset_kind, investigation_id)
    REFERENCES waspada.investigation_requests (dataset_kind, investigation_id),
  CHECK (
    (action_kind = 'tool'
      AND reserved_tool_attempts = 1
      AND reserved_reasoning_turns = 0
      AND reserved_model_tokens = 0)
    OR
    (action_kind = 'reasoning'
      AND reserved_tool_attempts = 0
      AND reserved_reasoning_turns = 1
      AND reserved_model_tokens BETWEEN 1 AND 12000)
  ),
  CHECK (actual_active_seconds <= reserved_active_seconds),
  CHECK (actual_model_tokens <= reserved_model_tokens),
  CHECK (
    (reservation_status = 'reserved'
      AND outcome IS NULL AND actual_active_seconds = 0 AND actual_model_tokens = 0
      AND started_at IS NULL AND finished_at IS NULL AND reconciled_checkpoint_version IS NULL)
    OR
    (reservation_status = 'started'
      AND outcome IS NULL AND actual_active_seconds = 0 AND actual_model_tokens = 0
      AND started_at IS NOT NULL AND finished_at IS NULL AND reconciled_checkpoint_version IS NULL)
    OR
    (reservation_status = 'reconciled'
      AND outcome IS NOT NULL AND started_at IS NOT NULL AND finished_at IS NOT NULL
      AND finished_at >= started_at AND reconciled_checkpoint_version IS NOT NULL
      AND reconciled_checkpoint_version > expected_checkpoint_version)
    OR
    (reservation_status = 'released'
      AND outcome IS NULL AND actual_active_seconds = 0 AND actual_model_tokens = 0
      AND started_at IS NULL AND finished_at IS NOT NULL
      AND finished_at >= created_at AND reconciled_checkpoint_version IS NOT NULL
      AND reconciled_checkpoint_version > expected_checkpoint_version)
  )
);

CREATE UNIQUE INDEX investigation_action_one_in_flight_per_case_idx
  ON waspada.investigation_action_reservations (dataset_kind, investigation_id)
  WHERE reservation_status IN ('reserved', 'started');

CREATE FUNCTION waspada.guard_investigation_action_reservation_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'investigation action reservations cannot be deleted';
  END IF;

  IF ROW(
       NEW.dataset_kind, NEW.reservation_id, NEW.investigation_id, NEW.action_kind,
       NEW.action_name, NEW.expected_checkpoint_version, NEW.reserved_tool_attempts,
       NEW.reserved_reasoning_turns, NEW.reserved_active_seconds, NEW.reserved_model_tokens,
       NEW.created_at
     ) IS DISTINCT FROM ROW(
       OLD.dataset_kind, OLD.reservation_id, OLD.investigation_id, OLD.action_kind,
       OLD.action_name, OLD.expected_checkpoint_version, OLD.reserved_tool_attempts,
       OLD.reserved_reasoning_turns, OLD.reserved_active_seconds, OLD.reserved_model_tokens,
       OLD.created_at
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

CREATE TRIGGER investigation_action_reservations_guard
  BEFORE UPDATE OR DELETE ON waspada.investigation_action_reservations
  FOR EACH ROW EXECUTE FUNCTION waspada.guard_investigation_action_reservation_update();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waspada_l3_coordinator') THEN
    CREATE ROLE waspada_l3_coordinator NOLOGIN;
  END IF;
END;
$$;

ALTER ROLE waspada_l3_coordinator
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

GRANT USAGE ON SCHEMA waspada TO waspada_l3_coordinator;

GRANT SELECT (dataset_kind, candidate_id)
  ON TABLE waspada.extraction_results TO waspada_l3_coordinator;

GRANT SELECT (dataset_kind, context_id, trace_id, candidate_id, sufficient)
  ON TABLE waspada.grounding_contexts TO waspada_l3_coordinator;

GRANT SELECT (
  dataset_kind, investigation_id, trace_id, candidate_id, context_id, event_id, event_version,
  questions, budget_policy_version, limit_tool_attempts, limit_reasoning_turns,
  limit_active_seconds, limit_model_tokens, consumed_tool_attempts, consumed_reasoning_turns,
  consumed_active_seconds, consumed_model_tokens, reserved_tool_attempts,
  reserved_reasoning_turns, reserved_active_seconds, reserved_model_tokens,
  requested_at, record_json
) ON TABLE waspada.investigation_requests TO waspada_l3_coordinator;

GRANT INSERT (
  dataset_kind, investigation_id, trace_id, candidate_id, context_id, event_id, event_version,
  questions, budget_policy_version, limit_tool_attempts, limit_reasoning_turns,
  limit_active_seconds, limit_model_tokens, requested_at, record_json
) ON TABLE waspada.investigation_requests TO waspada_l3_coordinator;

GRANT UPDATE (
  consumed_tool_attempts, consumed_reasoning_turns, consumed_active_seconds, consumed_model_tokens,
  reserved_tool_attempts, reserved_reasoning_turns, reserved_active_seconds, reserved_model_tokens
) ON TABLE waspada.investigation_requests TO waspada_l3_coordinator;

GRANT SELECT (
  dataset_kind, checkpoint_id, investigation_id, checkpoint_version, trace_id, candidate_id,
  context_id, event_id, event_version, case_status, stop_reason, budget_policy_version,
  limit_tool_attempts, limit_reasoning_turns, limit_active_seconds, limit_model_tokens,
  consumed_tool_attempts, consumed_reasoning_turns, consumed_active_seconds, consumed_model_tokens,
  reserved_tool_attempts, reserved_reasoning_turns, reserved_active_seconds, reserved_model_tokens,
  attempts, reasoning_runs, created_at, updated_at, completed_at, record_json
) ON TABLE waspada.investigation_checkpoints TO waspada_l3_coordinator;

GRANT INSERT (
  dataset_kind, checkpoint_id, investigation_id, checkpoint_version, trace_id, candidate_id,
  context_id, event_id, event_version, case_status, stop_reason, budget_policy_version,
  limit_tool_attempts, limit_reasoning_turns, limit_active_seconds, limit_model_tokens,
  consumed_tool_attempts, consumed_reasoning_turns, consumed_active_seconds, consumed_model_tokens,
  reserved_tool_attempts, reserved_reasoning_turns, reserved_active_seconds, reserved_model_tokens,
  attempts, reasoning_runs, created_at, updated_at, completed_at, record_json
) ON TABLE waspada.investigation_checkpoints TO waspada_l3_coordinator;

GRANT SELECT (
  dataset_kind, reservation_id, investigation_id, action_kind, action_name,
  expected_checkpoint_version, reserved_tool_attempts, reserved_reasoning_turns,
  reserved_active_seconds, reserved_model_tokens, reservation_status, outcome,
  actual_active_seconds, actual_model_tokens, created_at, started_at, finished_at,
  reconciled_checkpoint_version
) ON TABLE waspada.investigation_action_reservations TO waspada_l3_coordinator;

GRANT INSERT (
  dataset_kind, reservation_id, investigation_id, action_kind, action_name,
  expected_checkpoint_version, reserved_tool_attempts, reserved_reasoning_turns,
  reserved_active_seconds, reserved_model_tokens, reservation_status, created_at
) ON TABLE waspada.investigation_action_reservations TO waspada_l3_coordinator;

GRANT UPDATE (
  reservation_status, outcome, actual_active_seconds, actual_model_tokens,
  started_at, finished_at, reconciled_checkpoint_version
) ON TABLE waspada.investigation_action_reservations TO waspada_l3_coordinator;
