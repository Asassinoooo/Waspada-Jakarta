-- Freshness is a separate status history tied to immutable publication versions.
CREATE TABLE waspada.freshness_transitions (
  transition_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  event_id text NOT NULL,
  event_version integer NOT NULL CHECK (event_version > 0),
  target_kind text NOT NULL CHECK (target_kind IN ('event_claim_set', 'impact')),
  impact_id text,
  impact_version integer,
  transition_sequence integer NOT NULL CHECK (transition_sequence > 0),
  previous_status text NOT NULL CHECK (previous_status IN ('current', 'needs_update', 'expired')),
  resulting_status text NOT NULL CHECK (resulting_status IN ('current', 'needs_update', 'expired')),
  reason text NOT NULL CHECK (reason IN (
    'issuer_validity_ended', 'new_applicable_evidence_evaluated', 'review_deadline_missed'
  )),
  evaluated_at text NOT NULL CHECK (
    evaluated_at ~ '^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
  ),
  trace_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  UNIQUE (transition_id, dataset_kind),
  UNIQUE (idempotency_key),
  FOREIGN KEY (trace_id, dataset_kind) REFERENCES waspada.traces (trace_id, dataset_kind),
  FOREIGN KEY (dataset_kind, event_id, event_version)
    REFERENCES waspada.event_versions (dataset_kind, event_id, version),
  FOREIGN KEY (dataset_kind, event_id, event_version, impact_id, impact_version)
    REFERENCES waspada.event_impact_refs (dataset_kind, event_id, event_version, impact_id, impact_version),
  CHECK (
    (target_kind = 'event_claim_set' AND impact_id IS NULL AND impact_version IS NULL)
    OR (target_kind = 'impact' AND impact_id IS NOT NULL AND impact_version IS NOT NULL AND impact_version > 0)
  ),
  CHECK (previous_status <> resulting_status),
  CHECK (
    (reason = 'issuer_validity_ended' AND resulting_status = 'expired'
      AND previous_status IN ('current', 'needs_update'))
    OR (reason = 'review_deadline_missed' AND previous_status = 'current'
      AND resulting_status = 'needs_update')
    OR (reason = 'new_applicable_evidence_evaluated'
      AND previous_status IN ('needs_update', 'expired') AND resulting_status = 'current')
  )
);

CREATE UNIQUE INDEX freshness_transitions_event_sequence_uq
  ON waspada.freshness_transitions (dataset_kind, event_id, event_version, transition_sequence)
  WHERE target_kind = 'event_claim_set';
CREATE UNIQUE INDEX freshness_transitions_impact_sequence_uq
  ON waspada.freshness_transitions
    (dataset_kind, event_id, event_version, impact_id, impact_version, transition_sequence)
  WHERE target_kind = 'impact';
CREATE INDEX freshness_transitions_target_latest_idx
  ON waspada.freshness_transitions
    (dataset_kind, event_id, event_version, target_kind, impact_id, impact_version, transition_sequence DESC);

CREATE TABLE waspada.freshness_transition_evidence (
  transition_id bigint NOT NULL,
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  evidence_ref_id bigint NOT NULL,
  PRIMARY KEY (transition_id, evidence_ref_id),
  FOREIGN KEY (transition_id, dataset_kind)
    REFERENCES waspada.freshness_transitions (transition_id, dataset_kind),
  FOREIGN KEY (dataset_kind, evidence_ref_id)
    REFERENCES waspada.evidence_references (dataset_kind, evidence_ref_id)
);

CREATE FUNCTION waspada.guard_freshness_transition_append()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  latest_version integer;
  target_record jsonb;
  stored_status text;
  prior_sequence integer;
  prior_status text;
BEGIN
  -- Match the publication writer lock so a new immutable event version cannot race this guard.
  PERFORM pg_advisory_xact_lock(hashtextextended('waspada:publication-event:' || NEW.event_id, 0));

  BEGIN
    PERFORM NEW.evaluated_at::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid freshness transition input'
      USING ERRCODE = '23514', CONSTRAINT = 'freshness_transition_guard';
  END;

  SELECT event.record_json INTO target_record
  FROM waspada.event_versions AS event
  WHERE event.dataset_kind = NEW.dataset_kind
    AND event.event_id = NEW.event_id
    AND event.version = NEW.event_version
    AND event.publication_status = 'published';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'freshness transition target is not a published event version'
      USING ERRCODE = '23514', CONSTRAINT = 'freshness_transition_guard';
  END IF;

  SELECT max(event.version) INTO latest_version
  FROM waspada.event_versions AS event
  WHERE event.dataset_kind = NEW.dataset_kind AND event.event_id = NEW.event_id;
  IF latest_version IS DISTINCT FROM NEW.event_version THEN
    RAISE EXCEPTION 'freshness transition target is not the latest event version'
      USING ERRCODE = '23514', CONSTRAINT = 'freshness_transition_guard';
  END IF;

  IF NEW.target_kind = 'impact' THEN
    SELECT impact.record_json INTO target_record
    FROM waspada.event_impact_refs AS reference
    JOIN waspada.impact_versions AS impact
      ON impact.dataset_kind = reference.dataset_kind
     AND impact.event_id = reference.event_id
     AND impact.impact_id = reference.impact_id
     AND impact.version = reference.impact_version
    WHERE reference.dataset_kind = NEW.dataset_kind
      AND reference.event_id = NEW.event_id
      AND reference.event_version = NEW.event_version
      AND reference.impact_id = NEW.impact_id
      AND reference.impact_version = NEW.impact_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'freshness impact is not referenced by this event version'
        USING ERRCODE = '23514', CONSTRAINT = 'freshness_transition_guard';
    END IF;
  END IF;

  stored_status := target_record #>> '{freshness,status}';
  IF stored_status IS NULL OR stored_status NOT IN ('current', 'needs_update', 'expired') THEN
    RAISE EXCEPTION 'freshness transition target has invalid base status'
      USING ERRCODE = '23514', CONSTRAINT = 'freshness_transition_guard';
  END IF;

  SELECT transition.transition_sequence, transition.resulting_status
    INTO prior_sequence, prior_status
  FROM waspada.freshness_transitions AS transition
  WHERE transition.dataset_kind = NEW.dataset_kind
    AND transition.event_id = NEW.event_id
    AND transition.event_version = NEW.event_version
    AND transition.target_kind = NEW.target_kind
    AND transition.impact_id IS NOT DISTINCT FROM NEW.impact_id
    AND transition.impact_version IS NOT DISTINCT FROM NEW.impact_version
  ORDER BY transition.transition_sequence DESC
  LIMIT 1;

  IF FOUND THEN
    IF NEW.transition_sequence <> prior_sequence + 1 OR NEW.previous_status <> prior_status THEN
      RAISE EXCEPTION 'stale freshness transition sequence or prior status'
        USING ERRCODE = '23514', CONSTRAINT = 'freshness_transition_guard';
    END IF;
  ELSIF NEW.transition_sequence <> 1 OR NEW.previous_status <> stored_status THEN
    RAISE EXCEPTION 'stale initial freshness transition sequence or prior status'
      USING ERRCODE = '23514', CONSTRAINT = 'freshness_transition_guard';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER freshness_transitions_validate_insert
  BEFORE INSERT ON waspada.freshness_transitions
  FOR EACH ROW EXECUTE FUNCTION waspada.guard_freshness_transition_append();

CREATE FUNCTION waspada.require_freshness_recovery_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.reason = 'new_applicable_evidence_evaluated'
    AND NOT EXISTS (
      SELECT 1 FROM waspada.freshness_transition_evidence AS link
      WHERE link.transition_id = NEW.transition_id
        AND link.dataset_kind = NEW.dataset_kind
    ) THEN
    RAISE EXCEPTION 'freshness recovery requires evidence references'
      USING ERRCODE = '23514', CONSTRAINT = 'freshness_transition_evidence_required';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER freshness_transitions_recovery_evidence
  AFTER INSERT ON waspada.freshness_transitions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION waspada.require_freshness_recovery_evidence();

CREATE TRIGGER freshness_transitions_append_only
  BEFORE UPDATE OR DELETE ON waspada.freshness_transitions
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER freshness_transition_evidence_append_only
  BEFORE UPDATE OR DELETE ON waspada.freshness_transition_evidence
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waspada_l4_freshness_writer') THEN
    CREATE ROLE waspada_l4_freshness_writer NOLOGIN NOINHERIT;
  END IF;
END;
$$;

ALTER ROLE waspada_l4_freshness_writer
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- Keep the role a standalone capability even if a local database already had a role by this name.
REVOKE ALL PRIVILEGES ON SCHEMA waspada FROM waspada_l4_freshness_writer;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA waspada FROM waspada_l4_freshness_writer;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA waspada FROM waspada_l4_freshness_writer;

DO $$
DECLARE membership record;
BEGIN
  FOR membership IN
    SELECT granted.rolname AS granted_role
    FROM pg_auth_members AS m JOIN pg_roles AS granted ON granted.oid = m.roleid
    WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'waspada_l4_freshness_writer')
  LOOP
    EXECUTE format('REVOKE %I FROM waspada_l4_freshness_writer', membership.granted_role);
  END LOOP;
  FOR membership IN
    SELECT member_role.rolname AS member_role
    FROM pg_auth_members AS m JOIN pg_roles AS member_role ON member_role.oid = m.member
    WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'waspada_l4_freshness_writer')
  LOOP
    EXECUTE format('REVOKE waspada_l4_freshness_writer FROM %I', membership.member_role);
  END LOOP;
END;
$$;

REVOKE ALL PRIVILEGES ON waspada.freshness_transitions, waspada.freshness_transition_evidence FROM PUBLIC;
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'waspada_public_reader', 'waspada_l1_pipeline', 'waspada_l2_grounding_reader',
    'waspada_l2_grounding_writer', 'waspada_l2_proposal_writer',
    'waspada_l4_publication_writer', 'waspada_l4_moderator_publication_writer'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON waspada.freshness_transitions, waspada.freshness_transition_evidence FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END;
$$;
GRANT USAGE ON SCHEMA waspada TO waspada_l4_freshness_writer;

GRANT SELECT (dataset_kind, event_id, version, publication_status, record_json)
  ON waspada.event_versions TO waspada_l4_freshness_writer;
GRANT SELECT (dataset_kind, event_id, event_version, impact_id, impact_version)
  ON waspada.event_impact_refs TO waspada_l4_freshness_writer;
GRANT SELECT (dataset_kind, event_id, impact_id, version, record_json)
  ON waspada.impact_versions TO waspada_l4_freshness_writer;
GRANT SELECT (dataset_kind, evidence_ref_id)
  ON waspada.evidence_references TO waspada_l4_freshness_writer;
GRANT SELECT (dataset_kind, trace_id)
  ON waspada.traces TO waspada_l4_freshness_writer;

GRANT SELECT (transition_id, dataset_kind, event_id, event_version, target_kind, impact_id,
              impact_version, transition_sequence, previous_status, resulting_status, reason,
              evaluated_at, trace_id, idempotency_key, request_fingerprint)
  ON waspada.freshness_transitions TO waspada_l4_freshness_writer;
GRANT INSERT (dataset_kind, event_id, event_version, target_kind, impact_id, impact_version,
              transition_sequence, previous_status, resulting_status, reason, evaluated_at,
              trace_id, idempotency_key, request_fingerprint)
  ON waspada.freshness_transitions TO waspada_l4_freshness_writer;
GRANT SELECT (transition_id, dataset_kind, evidence_ref_id),
      INSERT (transition_id, dataset_kind, evidence_ref_id)
  ON waspada.freshness_transition_evidence TO waspada_l4_freshness_writer;
