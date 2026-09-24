-- JOB-01 durable acquisition queue. Queue rows contain request metadata only;
-- fetched source text and model output belong to their later pipeline records.
CREATE TABLE waspada.acquisition_jobs (
  job_id text NOT NULL CHECK (length(job_id) BETWEEN 1 AND 128),
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  job_kind text NOT NULL DEFAULT 'moderator_submission'
    CHECK (job_kind IN ('source_poll', 'moderator_submission')),
  trace_id text NOT NULL,
  source_id text REFERENCES waspada.source_registry (source_id),
  submitted_url text,
  requested_by text,
  request_fingerprint text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'retry', 'completed', 'terminal')),
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  max_attempts smallint NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 5),
  available_at timestamptz NOT NULL,
  lease_token text,
  lease_started_at timestamptz,
  lease_expires_at timestamptz,
  last_failure_code text CHECK (last_failure_code IS NULL OR last_failure_code ~ '^[a-z0-9][a-z0-9_.-]{0,79}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  finished_at timestamptz,
  PRIMARY KEY (job_id),
  UNIQUE (dataset_kind, idempotency_key),
  FOREIGN KEY (trace_id, dataset_kind) REFERENCES waspada.traces (trace_id, dataset_kind),
  CHECK (attempt_count <= max_attempts),
  CHECK (
    (job_kind = 'source_poll' AND source_id IS NOT NULL AND submitted_url IS NULL
      AND requested_by IS NULL AND request_fingerprint IS NULL)
    OR
    (job_kind = 'moderator_submission' AND source_id IS NULL
      AND submitted_url IS NOT NULL AND length(submitted_url) BETWEEN 1 AND 2048
      AND requested_by IS NOT NULL AND length(requested_by) BETWEEN 1 AND 200
      AND request_fingerprint IS NOT NULL
      AND request_fingerprint ~ '^[0-9a-f]{64}$')
  ),
  CHECK (updated_at >= created_at),
  CHECK (finished_at IS NULL OR finished_at >= created_at),
  CHECK (
    (status IN ('pending', 'retry') AND lease_token IS NULL
      AND lease_started_at IS NULL AND lease_expires_at IS NULL AND finished_at IS NULL)
    OR
    (status = 'leased' AND attempt_count BETWEEN 1 AND max_attempts
      AND lease_token IS NOT NULL AND length(lease_token) = 36
      AND lease_started_at IS NOT NULL AND lease_expires_at > lease_started_at
      AND finished_at IS NULL)
    OR
    (status IN ('completed', 'terminal') AND attempt_count BETWEEN 1 AND max_attempts
      AND lease_token IS NULL AND lease_started_at IS NULL
      AND lease_expires_at IS NULL AND finished_at IS NOT NULL)
  ),
  CHECK (status <> 'pending' OR attempt_count = 0),
  CHECK (status <> 'retry' OR (attempt_count > 0 AND attempt_count < max_attempts)),
  CHECK (status NOT IN ('completed', 'terminal') OR last_failure_code IS NOT NULL OR status = 'completed')
);

CREATE INDEX acquisition_jobs_due_idx
  ON waspada.acquisition_jobs (available_at, created_at, job_id)
  WHERE status IN ('pending', 'retry');
CREATE INDEX acquisition_jobs_expired_lease_idx
  ON waspada.acquisition_jobs (lease_expires_at, created_at, job_id)
  WHERE status = 'leased';
CREATE INDEX acquisition_jobs_source_idx
  ON waspada.acquisition_jobs (source_id, status, available_at)
  WHERE source_id IS NOT NULL;

REVOKE ALL ON waspada.acquisition_jobs FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON waspada.acquisition_jobs TO waspada_l1_pipeline;
GRANT SELECT (job_id, dataset_kind, idempotency_key, job_kind, request_fingerprint)
  ON waspada.acquisition_jobs TO waspada_l4_publication_writer;
GRANT INSERT (job_id, dataset_kind, idempotency_key, trace_id, submitted_url,
  requested_by, request_fingerprint, available_at, created_at, updated_at)
  ON waspada.acquisition_jobs TO waspada_l4_publication_writer;
