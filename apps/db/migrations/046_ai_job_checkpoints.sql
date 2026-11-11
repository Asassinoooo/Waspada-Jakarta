-- 046_ai_job_checkpoints.sql
-- AI-RATE-01: rate-limit deferral, durable AI job checkpoints, and a distinct
-- rate_limited triage outcome. Forward-only; never modifies 001-044.
-- Migration 045 is reserved for AUTH-PW-01 on a parallel branch.

-- 1. Checkpoint payload. Written after a successful interpret step so a retry
--    after a later failure does not repeat the interpretation model call.
--    Cleared by completeAiJob. Table-level grants from 037 cover the new column;
--    the grants below restate them so the update rights stay explicit.
ALTER TABLE waspada.ai_jobs
  ADD COLUMN IF NOT EXISTS checkpoint_json jsonb NULL
  CHECK (checkpoint_json IS NULL OR jsonb_typeof(checkpoint_json) = 'object');

-- 2. A rate-limited job gives its claimed attempt back, so status retry may
--    carry attempt_count 0 (038 required > 0). The upper bound is unchanged.
ALTER TABLE waspada.ai_jobs DROP CONSTRAINT IF EXISTS ai_jobs_retry_attempt_check;
ALTER TABLE waspada.ai_jobs
  ADD CONSTRAINT ai_jobs_retry_attempt_check
  CHECK (status <> 'retry' OR attempt_count < max_attempts);

-- 3. rate_limited is a distinct triage model outcome. It is not provider_error,
--    so it never consumes the provider_error retry budget. Drop whichever
--    model_status CHECK exists (inline names are auto-generated), then re-add it.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT conrelid::regclass::text AS table_name, conname
    FROM pg_constraint
    WHERE conrelid IN ('waspada.news_triage_decisions'::regclass, 'waspada.news_triage_attempts'::regclass)
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%model_status%'
  ) LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.table_name, r.conname);
  END LOOP;
END $$;

ALTER TABLE waspada.news_triage_decisions
  ADD CONSTRAINT news_triage_decisions_model_status_check
  CHECK (model_status IN ('ok', 'provider_error', 'invalid_model_output', 'skipped_stage_a', 'not_cleared', 'rate_limited'));

ALTER TABLE waspada.news_triage_attempts
  ADD CONSTRAINT news_triage_attempts_model_status_check
  CHECK (model_status IN ('ok', 'provider_error', 'invalid_model_output', 'skipped_stage_a', 'not_cleared', 'rate_limited'));

GRANT SELECT, INSERT, UPDATE ON waspada.ai_jobs TO waspada_l1_pipeline;
GRANT SELECT, INSERT, UPDATE, DELETE ON waspada.ai_jobs TO waspada_l2_proposal_writer;
