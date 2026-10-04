-- PUB-OUTBOX-DELIVERY-CORE: at-least-once delivery reservations and results.
-- The immutable publication_outbox remains the source record; this ledger only
-- records short delivery leases and their bounded outcomes.

CREATE ROLE waspada_l4_publication_outbox_delivery
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

REVOKE ALL PRIVILEGES ON SCHEMA waspada
  FROM waspada_l4_publication_outbox_delivery;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA waspada
  FROM waspada_l4_publication_outbox_delivery;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA waspada
  FROM waspada_l4_publication_outbox_delivery;
GRANT USAGE ON SCHEMA waspada TO waspada_l4_publication_outbox_delivery;

CREATE TABLE waspada.publication_outbox_delivery_attempts (
  attempt_id text PRIMARY KEY CHECK (attempt_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  outbox_id text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  reservation_key text NOT NULL CHECK (reservation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  reserved_at timestamptz NOT NULL CHECK (isfinite(reserved_at)),
  lease_expires_at timestamptz NOT NULL CHECK (isfinite(lease_expires_at) AND lease_expires_at > reserved_at),
  FOREIGN KEY (outbox_id) REFERENCES waspada.publication_outbox (outbox_id),
  UNIQUE (outbox_id, attempt_number),
  UNIQUE (reservation_key, outbox_id)
);

CREATE INDEX publication_outbox_delivery_attempts_by_notice
  ON waspada.publication_outbox_delivery_attempts (outbox_id, attempt_number DESC);

CREATE TABLE waspada.publication_outbox_delivery_results (
  attempt_id text PRIMARY KEY,
  outcome text NOT NULL CHECK (outcome IN ('delivered', 'retryable_failure', 'permanent_failure')),
  failure_classification text CHECK (failure_classification IN ('timeout', 'transient', 'unknown', 'permanent_rejection')),
  completed_at timestamptz NOT NULL CHECK (isfinite(completed_at)),
  retry_after timestamptz CHECK (retry_after IS NULL OR isfinite(retry_after)),
  FOREIGN KEY (attempt_id) REFERENCES waspada.publication_outbox_delivery_attempts (attempt_id),
  CHECK (
    (outcome = 'delivered' AND failure_classification IS NULL AND retry_after IS NULL)
    OR (outcome = 'retryable_failure'
      AND failure_classification IN ('timeout', 'transient', 'unknown')
      AND retry_after IS NOT NULL AND retry_after > completed_at)
    OR (outcome = 'permanent_failure'
      AND failure_classification = 'permanent_rejection' AND retry_after IS NULL)
  )
);

CREATE TRIGGER publication_outbox_delivery_attempts_append_only
  BEFORE UPDATE OR DELETE ON waspada.publication_outbox_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();

CREATE TRIGGER publication_outbox_delivery_results_append_only
  BEFORE UPDATE OR DELETE ON waspada.publication_outbox_delivery_results
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();

-- Keep the immutable source outbox ACLs unchanged. The new delivery role has
-- no existing grants and receives only these column-level reads.
REVOKE ALL PRIVILEGES ON TABLE
  waspada.publication_outbox_delivery_attempts,
  waspada.publication_outbox_delivery_results
FROM PUBLIC;

GRANT SELECT (
  outbox_id, dataset_kind, event_id, event_version, event_kind, occurred_at
) ON TABLE waspada.publication_outbox
  TO waspada_l4_publication_outbox_delivery;

GRANT SELECT (
  attempt_id, outbox_id, attempt_number, reservation_key, reserved_at, lease_expires_at
) ON TABLE waspada.publication_outbox_delivery_attempts
  TO waspada_l4_publication_outbox_delivery;
GRANT INSERT (
  attempt_id, outbox_id, attempt_number, reservation_key, reserved_at, lease_expires_at
) ON TABLE waspada.publication_outbox_delivery_attempts
  TO waspada_l4_publication_outbox_delivery;

GRANT SELECT (attempt_id, outcome, failure_classification, completed_at, retry_after)
  ON TABLE waspada.publication_outbox_delivery_results
  TO waspada_l4_publication_outbox_delivery;
GRANT INSERT (attempt_id, outcome, failure_classification, completed_at, retry_after)
  ON TABLE waspada.publication_outbox_delivery_results
  TO waspada_l4_publication_outbox_delivery;
