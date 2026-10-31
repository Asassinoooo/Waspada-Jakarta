-- 039_pipeline_unification_and_idempotency.sql
-- WJ-INT-01D: Forward migration for pipeline idempotency tracking, safe constraint reconciliation, and retry idempotency

-- 1. Create table for pipeline processing idempotency
CREATE TABLE IF NOT EXISTS waspada.incident_processing_records (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  report_revision_id text NOT NULL,
  pipeline_version text NOT NULL DEFAULT 'v1' CHECK (length(pipeline_version) BETWEEN 1 AND 64),
  incident_id text NOT NULL,
  decision_id text NOT NULL,
  proposal_id text NOT NULL,
  processed_at timestamptz NOT NULL,
  PRIMARY KEY (dataset_kind, report_revision_id, pipeline_version),
  FOREIGN KEY (dataset_kind, incident_id) REFERENCES waspada.incidents (dataset_kind, incident_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS incident_proc_rec_incident_idx
  ON waspada.incident_processing_records (dataset_kind, incident_id);

CREATE INDEX IF NOT EXISTS incident_proc_rec_proposal_idx
  ON waspada.incident_processing_records (dataset_kind, proposal_id);

REVOKE ALL ON waspada.incident_processing_records FROM PUBLIC;

-- 2. Verify and ensure ai_jobs specific status constraint safely without broad drops
DO $$
BEGIN
  -- If status check constraint exists, ensure it allows 'needs_review'
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'waspada.ai_jobs'::regclass
      AND conname = 'ai_jobs_status_check'
  ) THEN
    ALTER TABLE waspada.ai_jobs DROP CONSTRAINT ai_jobs_status_check;
  END IF;

  ALTER TABLE waspada.ai_jobs
    ADD CONSTRAINT ai_jobs_status_check
    CHECK (status IN ('pending', 'leased', 'retry', 'completed', 'terminal', 'needs_review'));
END $$;
