-- Local-only synthetic inbox state. This file is applied by the opt-in PGlite
-- bootstrap and is deliberately outside apps/db/migrations.
CREATE TABLE IF NOT EXISTS waspada.local_pipeline_owner (
  singleton smallint PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  profile_id text NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 128),
  dataset_kind text NOT NULL DEFAULT 'synthetic' CHECK (dataset_kind = 'synthetic'),
  pipeline_schema text NOT NULL DEFAULT 'local-private-pipeline-v1'
    CHECK (pipeline_schema = 'local-private-pipeline-v1'),
  initialized_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS waspada.local_report_heads (
  source_id text NOT NULL REFERENCES waspada.source_registry (source_id),
  stable_report_id text NOT NULL CHECK (length(stable_report_id) BETWEEN 1 AND 200),
  latest_version integer NOT NULL DEFAULT 0 CHECK (latest_version >= 0),
  latest_content_hash text CHECK (latest_content_hash IS NULL OR latest_content_hash ~ '^[0-9a-f]{64}$'),
  latest_report_revision_id text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (source_id, stable_report_id),
  CHECK ((latest_version = 0 AND latest_content_hash IS NULL AND latest_report_revision_id IS NULL)
      OR (latest_version > 0 AND latest_content_hash IS NOT NULL AND latest_report_revision_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS waspada.local_report_snapshots (
  snapshot_id text PRIMARY KEY CHECK (length(snapshot_id) BETWEEN 1 AND 128),
  dataset_kind text NOT NULL DEFAULT 'synthetic' CHECK (dataset_kind = 'synthetic'),
  source_id text NOT NULL REFERENCES waspada.source_registry (source_id),
  stable_report_id text NOT NULL CHECK (length(stable_report_id) BETWEEN 1 AND 200),
  version integer NOT NULL CHECK (version > 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 4000),
  report_text text NOT NULL CHECK (length(report_text) BETWEEN 1 AND 16384),
  published_at_text text,
  observed_at_text text,
  canonical_url text NOT NULL,
  source_revision_key text NOT NULL CHECK (length(source_revision_key) BETWEEN 1 AND 256),
  report_revision_id text NOT NULL UNIQUE,
  candidate_id text NOT NULL UNIQUE,
  trace_id text NOT NULL,
  supersedes_id text,
  captured_at_text text NOT NULL,
  UNIQUE (source_id, stable_report_id, version),
  FOREIGN KEY (trace_id, dataset_kind) REFERENCES waspada.traces (trace_id, dataset_kind),
  FOREIGN KEY (source_id, stable_report_id) REFERENCES waspada.local_report_heads (source_id, stable_report_id)
);

CREATE INDEX IF NOT EXISTS local_report_snapshots_report_order_idx
  ON waspada.local_report_snapshots (source_id, stable_report_id, version);

CREATE TABLE IF NOT EXISTS waspada.local_report_inbox (
  source_poll_job_id text PRIMARY KEY REFERENCES waspada.acquisition_jobs (job_id),
  dataset_kind text NOT NULL DEFAULT 'synthetic' CHECK (dataset_kind = 'synthetic'),
  source_id text NOT NULL DEFAULT 'local-authored-api' CHECK (source_id = 'local-authored-api'),
  snapshot_id text NOT NULL UNIQUE REFERENCES waspada.local_report_snapshots (snapshot_id),
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS waspada.local_ai_jobs (
  job_id text PRIMARY KEY CHECK (length(job_id) BETWEEN 1 AND 128),
  snapshot_id text NOT NULL UNIQUE REFERENCES waspada.local_report_snapshots (snapshot_id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'retry', 'completed', 'terminal')),
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  max_attempts smallint NOT NULL DEFAULT 5 CHECK (max_attempts = 5),
  available_at timestamptz NOT NULL,
  lease_token text,
  lease_started_at timestamptz,
  lease_expires_at timestamptz,
  last_failure_code text CHECK (last_failure_code IS NULL OR last_failure_code IN (
    'l1_failed', 'prerequisite_pending', 'model_timeout', 'model_failed',
    'invalid_output', 'context_insufficient', 'persistence_failed', 'lease_expired'
  )),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  finished_at timestamptz,
  CHECK (attempt_count <= max_attempts),
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
  CHECK (status <> 'retry' OR (attempt_count > 0 AND attempt_count < max_attempts))
);

CREATE INDEX IF NOT EXISTS local_ai_jobs_due_idx
  ON waspada.local_ai_jobs (available_at, created_at, job_id)
  WHERE status IN ('pending', 'retry');
CREATE INDEX IF NOT EXISTS local_ai_jobs_expired_idx
  ON waspada.local_ai_jobs (lease_expires_at, created_at, job_id)
  WHERE status = 'leased';

CREATE TABLE IF NOT EXISTS waspada.local_ai_receipts (
  job_id text NOT NULL REFERENCES waspada.local_ai_jobs (job_id),
  stage text NOT NULL CHECK (stage IN ('extraction', 'embedding', 'grounding', 'reasoning', 'proposal')),
  receipt_json jsonb NOT NULL,
  receipt_sha256 text NOT NULL CHECK (receipt_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (job_id, stage),
  CHECK (jsonb_typeof(receipt_json) IN ('object', 'array', 'string', 'number', 'boolean', 'null'))
);

CREATE OR REPLACE FUNCTION waspada.reject_local_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'local AI receipts are append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS local_ai_receipts_append_only ON waspada.local_ai_receipts;
CREATE TRIGGER local_ai_receipts_append_only
  BEFORE UPDATE OR DELETE ON waspada.local_ai_receipts
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_local_receipt_mutation();
