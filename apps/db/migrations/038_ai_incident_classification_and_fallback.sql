-- 038_ai_incident_classification_and_fallback.sql
-- WJ-INT-01C: Widen ai_jobs status to include 'needs_review' and ensure open-ended incident types

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'waspada.ai_jobs'::regclass
      AND contype = 'c'
  ) LOOP
    EXECUTE 'ALTER TABLE waspada.ai_jobs DROP CONSTRAINT IF EXISTS ' || quote_ident(r.conname);
  END LOOP;
END $$;

ALTER TABLE waspada.ai_jobs
  ADD CONSTRAINT ai_jobs_job_id_check
  CHECK (length(job_id) BETWEEN 1 AND 128);

ALTER TABLE waspada.ai_jobs
  ADD CONSTRAINT ai_jobs_dataset_kind_check
  CHECK (dataset_kind IN ('live', 'historical', 'synthetic'));

ALTER TABLE waspada.ai_jobs
  ADD CONSTRAINT ai_jobs_status_check
  CHECK (status IN ('pending', 'leased', 'retry', 'completed', 'terminal', 'needs_review'));

ALTER TABLE waspada.ai_jobs
  ADD CONSTRAINT ai_jobs_attempt_count_range_check
  CHECK (attempt_count BETWEEN 0 AND 5);

ALTER TABLE waspada.ai_jobs
  ADD CONSTRAINT ai_jobs_max_attempts_range_check
  CHECK (max_attempts BETWEEN 1 AND 5);

ALTER TABLE waspada.ai_jobs
  ADD CONSTRAINT ai_jobs_last_failure_code_check
  CHECK (last_failure_code IS NULL OR last_failure_code ~ '^[a-z0-9][a-z0-9_.-]{0,79}$');

ALTER TABLE waspada.ai_jobs
  ADD CONSTRAINT ai_jobs_attempt_count_check
  CHECK (attempt_count <= max_attempts);

ALTER TABLE waspada.ai_jobs
  ADD CONSTRAINT ai_jobs_updated_at_check
  CHECK (updated_at >= created_at);

ALTER TABLE waspada.ai_jobs
  ADD CONSTRAINT ai_jobs_finished_at_check
  CHECK (finished_at IS NULL OR finished_at >= created_at);

ALTER TABLE waspada.ai_jobs
  ADD CONSTRAINT ai_jobs_lifecycle_check
  CHECK (
    (status IN ('pending', 'retry') AND lease_token IS NULL
      AND lease_started_at IS NULL AND lease_expires_at IS NULL AND finished_at IS NULL)
    OR
    (status = 'leased' AND attempt_count BETWEEN 1 AND max_attempts
      AND lease_token IS NOT NULL AND length(lease_token) = 36
      AND lease_started_at IS NOT NULL AND lease_expires_at > lease_started_at
      AND finished_at IS NULL)
    OR
    (status IN ('completed', 'terminal', 'needs_review') AND attempt_count BETWEEN 1 AND max_attempts
      AND lease_token IS NULL AND lease_started_at IS NULL
      AND lease_expires_at IS NULL AND finished_at IS NOT NULL)
  );

ALTER TABLE waspada.ai_jobs
  ADD CONSTRAINT ai_jobs_pending_attempt_check
  CHECK (status <> 'pending' OR attempt_count = 0);

ALTER TABLE waspada.ai_jobs
  ADD CONSTRAINT ai_jobs_retry_attempt_check
  CHECK (status <> 'retry' OR (attempt_count > 0 AND attempt_count < max_attempts));

ALTER TABLE waspada.ai_jobs
  ADD CONSTRAINT ai_jobs_terminal_failure_check
  CHECK (status NOT IN ('completed', 'terminal', 'needs_review') OR last_failure_code IS NOT NULL OR status = 'completed');

CREATE INDEX IF NOT EXISTS ai_jobs_needs_review_idx
  ON waspada.ai_jobs (available_at, created_at, job_id)
  WHERE status = 'needs_review';
