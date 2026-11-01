-- 041_triage_revision_lineage.sql
-- WJ-INT-02A: revision-keyed decision lineage, append-only attempt ledger, reviewed flag.
-- Forward-only; never modifies 001-040.

-- 1. Revision linkage + review columns on the per-item decision row (latest evaluation).
ALTER TABLE waspada.news_triage_decisions
  ADD COLUMN IF NOT EXISTS report_revision_id text NULL,
  ADD COLUMN IF NOT EXISTS content_hash text NULL CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  ADD COLUMN IF NOT EXISTS supersedes_hash text NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS reviewed_by text NULL;

-- One revision maps to at most one accepted decision row per dataset.
CREATE UNIQUE INDEX IF NOT EXISTS news_triage_decisions_revision_uidx
  ON waspada.news_triage_decisions (dataset_kind, report_revision_id)
  WHERE report_revision_id IS NOT NULL;

-- Bounded uncertain-queue reads for moderator inspection.
CREATE INDEX IF NOT EXISTS news_triage_decisions_review_idx
  ON waspada.news_triage_decisions (dataset_kind, disposition, reviewed_at)
  WHERE disposition = 'uncertain';

-- 2. Append-only attempt ledger: every evaluation producing a report_revision_id
-- inserts here; the decisions table keeps the latest per item hash. Retries of
-- uncertain items therefore preserve history instead of overwriting it.
CREATE TABLE IF NOT EXISTS waspada.news_triage_attempts (
  attempt_id text PRIMARY KEY DEFAULT ('attempt-' || replace(gen_random_uuid()::text, '-', '')),
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  item_identity_hash text NOT NULL CHECK (item_identity_hash ~ '^[0-9a-f]{64}$'),
  report_revision_id text NOT NULL,
  source_id text NOT NULL,
  trace_id text NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('ingest', 'drop', 'uncertain')),
  jakarta_scope text NOT NULL CHECK (jakarta_scope IN ('dki_jakarta', 'direct_jakarta_impact', 'outside_scope', 'unknown')),
  actionability text NOT NULL CHECK (actionability IN ('immediate', 'actionable', 'context_only', 'none', 'unknown')),
  primary_category text NULL CHECK (primary_category IS NULL OR primary_category IN (
    'crime_personal_security',
    'demonstrations_public_gatherings',
    'crowds_major_events',
    'violence_immediate_threats',
    'disasters_weather',
    'fires_infrastructure_hazards',
    'transport_road_incidents',
    'utilities_essential_services',
    'health_environmental_advisories',
    'group_specific_critical_notices'
  )),
  incident_type text NULL CHECK (incident_type IS NULL OR length(incident_type) BETWEEN 1 AND 200),
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  reason_codes text[] NOT NULL DEFAULT '{}',
  policy_version text NOT NULL DEFAULT 'wj-int-02-v1',
  model_status text NOT NULL DEFAULT 'ok'
    CHECK (model_status IN ('ok', 'provider_error', 'invalid_model_output', 'skipped_stage_a', 'not_cleared')),
  content_hash text NULL CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  supersedes_hash text NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS news_triage_attempts_revision_idx
  ON waspada.news_triage_attempts (dataset_kind, report_revision_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS news_triage_attempts_item_idx
  ON waspada.news_triage_attempts (dataset_kind, item_identity_hash, evaluated_at DESC);

REVOKE ALL ON waspada.news_triage_decisions FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON waspada.news_triage_decisions TO waspada_l1_pipeline;
GRANT SELECT, INSERT, UPDATE ON waspada.news_triage_decisions TO waspada_l2_proposal_writer;
REVOKE ALL ON waspada.news_triage_attempts FROM PUBLIC;
GRANT SELECT, INSERT ON waspada.news_triage_attempts TO waspada_l1_pipeline;
GRANT SELECT, INSERT ON waspada.news_triage_attempts TO waspada_l2_proposal_writer;
