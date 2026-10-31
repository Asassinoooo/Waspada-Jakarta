-- 040_news_triage_and_primary_category.sql
-- WJ-INT-02: Pre-ingestion relevance gate audit table + canonical primary category on incidents.

-- 1. Canonical primary category on incidents (nullable for pre-existing rows).
ALTER TABLE waspada.incidents
  ADD COLUMN IF NOT EXISTS primary_category text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'waspada.incidents'::regclass
      AND conname = 'incidents_primary_category_check'
  ) THEN
    ALTER TABLE waspada.incidents
      ADD CONSTRAINT incidents_primary_category_check
      CHECK (primary_category IS NULL OR primary_category IN (
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
      ));
  END IF;
END $$;

-- 2. Pre-ingestion triage decision audit (metadata only; never title/body).
CREATE TABLE IF NOT EXISTS waspada.news_triage_decisions (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  item_identity_hash text NOT NULL CHECK (item_identity_hash ~ '^[0-9a-f]{64}$'),
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
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  PRIMARY KEY (dataset_kind, item_identity_hash)
);

CREATE INDEX IF NOT EXISTS news_triage_decisions_disposition_idx
  ON waspada.news_triage_decisions (dataset_kind, disposition, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS news_triage_decisions_source_idx
  ON waspada.news_triage_decisions (dataset_kind, source_id, evaluated_at DESC);

REVOKE ALL ON waspada.news_triage_decisions FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON waspada.news_triage_decisions TO waspada_l1_pipeline;
GRANT SELECT, INSERT, UPDATE ON waspada.news_triage_decisions TO waspada_l2_proposal_writer;
