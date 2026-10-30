-- 037_ai_incident_intelligence_pipeline.sql
-- Milestone WJ-INT-01: AI Incident Intelligence Pipeline
-- Introduces durable AI jobs, persistent incident identities, report links, and correlation decisions.

CREATE TABLE IF NOT EXISTS waspada.ai_jobs (
  job_id text NOT NULL CHECK (length(job_id) BETWEEN 1 AND 128),
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  report_revision_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'retry', 'completed', 'terminal')),
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  max_attempts smallint NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 5),
  available_at timestamptz NOT NULL,
  lease_token text,
  lease_started_at timestamptz,
  lease_expires_at timestamptz,
  last_failure_code text CHECK (last_failure_code IS NULL OR last_failure_code ~ '^[a-z0-9][a-z0-9_.-]{0,79}$'),
  trace_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  finished_at timestamptz,
  PRIMARY KEY (job_id),
  UNIQUE (dataset_kind, report_revision_id),
  CHECK (attempt_count <= max_attempts),
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

CREATE INDEX IF NOT EXISTS ai_jobs_due_idx
  ON waspada.ai_jobs (available_at, created_at, job_id)
  WHERE status IN ('pending', 'retry');
CREATE INDEX IF NOT EXISTS ai_jobs_expired_lease_idx
  ON waspada.ai_jobs (lease_expires_at, created_at, job_id)
  WHERE status = 'leased';

CREATE TABLE IF NOT EXISTS waspada.incidents (
  incident_id text NOT NULL CHECK (length(incident_id) BETWEEN 1 AND 128),
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  description text NOT NULL,
  incident_type text NOT NULL CHECK (length(incident_type) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('investigating', 'active', 'monitoring', 'resolved', 'closed')),
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical', 'unknown')),
  location_label text,
  shape geometry(Geometry, 4326),
  event_time jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_observed_at timestamptz NOT NULL,
  last_updated_at timestamptz NOT NULL,
  discrepancies jsonb NOT NULL DEFAULT '[]'::jsonb,
  uncertainty_notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  record_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (dataset_kind, incident_id)
);

CREATE INDEX IF NOT EXISTS incidents_shape_gix ON waspada.incidents USING GIST (shape);
CREATE INDEX IF NOT EXISTS incidents_status_idx ON waspada.incidents (dataset_kind, status, last_updated_at DESC);

CREATE TABLE IF NOT EXISTS waspada.incident_reports (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  incident_id text NOT NULL,
  report_revision_id text NOT NULL,
  relationship text NOT NULL CHECK (relationship IN ('primary_initial', 'corroborating', 'updating', 'contradicting', 'unresolved')),
  correlation_decision_id text,
  linked_at timestamptz NOT NULL,
  PRIMARY KEY (dataset_kind, incident_id, report_revision_id),
  FOREIGN KEY (dataset_kind, incident_id) REFERENCES waspada.incidents (dataset_kind, incident_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS incident_reports_revision_idx ON waspada.incident_reports (dataset_kind, report_revision_id);

CREATE TABLE IF NOT EXISTS waspada.incident_correlation_decisions (
  decision_id text NOT NULL CHECK (length(decision_id) BETWEEN 1 AND 128),
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  report_revision_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('same_incident', 'new_incident', 'unresolved')),
  target_incident_id text,
  reasoning text NOT NULL,
  evidence_quotes jsonb NOT NULL DEFAULT '[]'::jsonb,
  conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
  uncertainty jsonb NOT NULL DEFAULT '[]'::jsonb,
  record_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (dataset_kind, decision_id)
);

CREATE INDEX IF NOT EXISTS incident_corr_decisions_report_idx ON waspada.incident_correlation_decisions (dataset_kind, report_revision_id);

REVOKE ALL ON waspada.ai_jobs FROM PUBLIC;
REVOKE ALL ON waspada.incidents FROM PUBLIC;
REVOKE ALL ON waspada.incident_reports FROM PUBLIC;
REVOKE ALL ON waspada.incident_correlation_decisions FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON waspada.ai_jobs TO waspada_l1_pipeline;
GRANT SELECT, INSERT, UPDATE, DELETE ON waspada.ai_jobs TO waspada_l2_proposal_writer;
GRANT SELECT, INSERT, UPDATE ON waspada.incidents TO waspada_l2_proposal_writer;
GRANT SELECT, INSERT, UPDATE ON waspada.incident_reports TO waspada_l2_proposal_writer;
GRANT SELECT, INSERT, UPDATE ON waspada.incident_correlation_decisions TO waspada_l2_proposal_writer;

GRANT SELECT ON waspada.incidents TO waspada_l4_publication_writer;
GRANT SELECT ON waspada.incident_reports TO waspada_l4_publication_writer;
GRANT SELECT ON waspada.incident_correlation_decisions TO waspada_l4_publication_writer;
