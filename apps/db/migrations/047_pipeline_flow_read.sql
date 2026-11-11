-- 047_pipeline_flow_read.sql
-- FLOW-VIS-01: a read-only capability for the moderator pipeline flow view (`#alur-agen`).
-- Forward-only. It adds one NOLOGIN role, column-level SELECT on the counts and metadata the
-- view needs, and four narrow views that expose only derived keys from JSON columns. The role
-- gets no permitted text, chunk text, claim text, prompts, model output, checkpoint content,
-- vectors or keys. It has no write rights anywhere. The LIFE-01 freshness-writer pause is untouched.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waspada_l4_pipeline_flow_reader') THEN
    CREATE ROLE waspada_l4_pipeline_flow_reader NOLOGIN;
  END IF;
END;
$$;

ALTER ROLE waspada_l4_pipeline_flow_reader
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA waspada FROM waspada_l4_pipeline_flow_reader;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA waspada FROM waspada_l4_pipeline_flow_reader;
GRANT USAGE ON SCHEMA waspada TO waspada_l4_pipeline_flow_reader;

-- Derived-key views. They run with the owner's rights, so the role never reads the JSON columns.
CREATE OR REPLACE VIEW waspada.pipeline_flow_proposals WITH (security_barrier = true) AS
  SELECT ep.dataset_kind,
         ep.proposal_id,
         ep.proposed_at,
         ep.record_json ->> 'title' AS title,
         (ep.record_json ->> 'has_discrepancy') = 'true' AS has_discrepancy
    FROM waspada.event_proposals ep;

CREATE OR REPLACE VIEW waspada.pipeline_flow_decisions WITH (security_barrier = true) AS
  SELECT pd.dataset_kind,
         pd.decision_id,
         pd.proposal_id,
         pd.decided_at,
         pd.record_json ->> 'disposition' AS disposition,
         pd.record_json ->> 'actor_kind' AS actor_kind
    FROM waspada.publication_decisions pd;

CREATE OR REPLACE VIEW waspada.pipeline_flow_versions WITH (security_barrier = true) AS
  SELECT ev.dataset_kind,
         ev.event_id,
         ev.version,
         ev.title,
         ev.publication_status,
         ev.published_at,
         ev.record_json ->> 'publication_mode' AS publication_mode
    FROM waspada.event_versions ev;

CREATE OR REPLACE VIEW waspada.pipeline_flow_ai_jobs WITH (security_barrier = true) AS
  SELECT aj.dataset_kind,
         aj.job_id,
         aj.status,
         aj.last_failure_code,
         aj.updated_at,
         aj.finished_at,
         (aj.checkpoint_json -> 'interpretation') IS NOT NULL AS has_interpretation
    FROM waspada.ai_jobs aj;

REVOKE ALL ON waspada.pipeline_flow_proposals, waspada.pipeline_flow_decisions,
  waspada.pipeline_flow_versions, waspada.pipeline_flow_ai_jobs FROM PUBLIC;

-- Column-level grants on base tables that carry no JSON payload the view needs.
GRANT SELECT (source_id, access_method, health_status, registry_status, approval_status)
  ON TABLE waspada.source_registry TO waspada_l4_pipeline_flow_reader;
GRANT SELECT (dataset_kind, report_revision_id, source_id, revision_status, retrieved_at)
  ON TABLE waspada.report_revisions TO waspada_l4_pipeline_flow_reader;
GRANT SELECT (dataset_kind, source_id, job_kind, status, updated_at)
  ON TABLE waspada.acquisition_jobs TO waspada_l4_pipeline_flow_reader;
GRANT SELECT (dataset_kind, status)
  ON TABLE waspada.evidence_chunks TO waspada_l4_pipeline_flow_reader;
GRANT SELECT (dataset_kind, item_identity_hash, disposition, model_status, evaluated_at)
  ON TABLE waspada.news_triage_decisions TO waspada_l4_pipeline_flow_reader;
GRANT SELECT (dataset_kind, embedding_run_id, status, created_at)
  ON TABLE waspada.embedding_runs TO waspada_l4_pipeline_flow_reader;
GRANT SELECT (dataset_kind, decision_id, decision, created_at)
  ON TABLE waspada.incident_correlation_decisions TO waspada_l4_pipeline_flow_reader;
GRANT SELECT (dataset_kind, status)
  ON TABLE waspada.incidents TO waspada_l4_pipeline_flow_reader;

GRANT SELECT ON waspada.pipeline_flow_proposals, waspada.pipeline_flow_decisions,
  waspada.pipeline_flow_versions, waspada.pipeline_flow_ai_jobs
  TO waspada_l4_pipeline_flow_reader;
