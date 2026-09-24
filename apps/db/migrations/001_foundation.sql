-- DATA-01 relational foundation. Keep this migration portable across PostgreSQL 17/18.
-- Extension versions are selected by the database installation, never by this schema.
CREATE SCHEMA IF NOT EXISTS waspada;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS waspada.schema_migrations (
  version text PRIMARY KEY,
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE waspada.traces (
  trace_id text PRIMARY KEY,
  dataset_kind text CHECK (dataset_kind IS NULL OR dataset_kind IN ('live', 'historical', 'synthetic')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  outcome text CHECK (outcome IS NULL OR outcome IN ('open', 'succeeded', 'failed', 'cancelled')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  UNIQUE (trace_id, dataset_kind)
);

CREATE TABLE waspada.audit_records (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  audit_id text NOT NULL,
  trace_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  actor_id text,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 120),
  entity_type text NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 120),
  entity_id text NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 200),
  reason text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  PRIMARY KEY (dataset_kind, audit_id),
  FOREIGN KEY (trace_id, dataset_kind) REFERENCES waspada.traces (trace_id, dataset_kind)
);

CREATE TABLE waspada.source_registry (
  source_id text PRIMARY KEY,
  trace_id text NOT NULL REFERENCES waspada.traces (trace_id),
  registry_version integer NOT NULL CHECK (registry_version > 0),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  source_kind text NOT NULL CHECK (source_kind IN ('authority', 'operator', 'newsroom', 'institution', 'crowdsourced_platform', 'other')),
  publisher_group_id text,
  remit text[] NOT NULL CHECK (cardinality(remit) > 0),
  access_method text NOT NULL CHECK (access_method IN ('api', 'rss', 'public_web', 'moderator_submission', 'manual_fixture')),
  approved_hosts text[] NOT NULL DEFAULT '{}',
  access_restrictions text[] NOT NULL DEFAULT '{}',
  reuse_basis text[] NOT NULL CHECK (cardinality(reuse_basis) > 0),
  registry_status text NOT NULL CHECK (registry_status IN ('active', 'paused', 'retired')),
  approval_status text NOT NULL CHECK (approval_status IN ('pending', 'approved', 'suspended', 'revoked')),
  health_status text NOT NULL CHECK (health_status IN ('unknown', 'healthy', 'degraded', 'unavailable')),
  auto_acquisition_enabled boolean NOT NULL,
  auto_publication_policy text NOT NULL CHECK (auto_publication_policy IN ('never', 'approved_issuer_notice')),
  polling_interval_seconds integer CHECK (polling_interval_seconds IS NULL OR polling_interval_seconds > 0),
  last_checked_at timestamptz,
  last_success_at timestamptz,
  CHECK (approval_status = 'approved' OR auto_publication_policy = 'never'),
  CHECK (source_kind IN ('authority', 'operator', 'institution') OR auto_publication_policy = 'never'),
  CHECK (registry_status <> 'retired' OR auto_acquisition_enabled = false),
  CONSTRAINT source_registry_auto_acquisition_eligible_check
    CHECK (NOT auto_acquisition_enabled OR (approval_status = 'approved' AND registry_status = 'active'))
);

CREATE TABLE waspada.report_revisions (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  report_revision_id text NOT NULL,
  trace_id text NOT NULL,
  source_id text NOT NULL REFERENCES waspada.source_registry (source_id),
  canonical_url text NOT NULL,
  source_revision_key text,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  permitted_text text NOT NULL CHECK (length(permitted_text) BETWEEN 1 AND 2000000),
  permitted_text_hash text NOT NULL CHECK (permitted_text_hash ~ '^[0-9a-f]{64}$'),
  normalization_version text NOT NULL,
  published_at timestamptz,
  observed_at timestamptz,
  retrieved_at timestamptz NOT NULL,
  valid_from timestamptz,
  valid_until timestamptz,
  supersedes_id text,
  revision_status text NOT NULL CHECK (revision_status IN ('unreviewed', 'eligible', 'quarantined', 'superseded', 'retracted')),
  record_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(record_json) = 'object'),
  PRIMARY KEY (dataset_kind, report_revision_id),
  UNIQUE (dataset_kind, report_revision_id, permitted_text_hash),
  UNIQUE (dataset_kind, report_revision_id, source_id),
  FOREIGN KEY (trace_id, dataset_kind) REFERENCES waspada.traces (trace_id, dataset_kind),
  FOREIGN KEY (dataset_kind, supersedes_id, source_id)
    REFERENCES waspada.report_revisions (dataset_kind, report_revision_id, source_id),
  CHECK (source_revision_key IS NULL OR length(source_revision_key) BETWEEN 1 AND 256),
  CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from < valid_until)
);

CREATE TABLE waspada.evidence_references (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  evidence_ref_id bigint GENERATED ALWAYS AS IDENTITY,
  trace_id text NOT NULL,
  report_revision_id text NOT NULL,
  permitted_text_hash text NOT NULL CHECK (permitted_text_hash ~ '^[0-9a-f]{64}$'),
  span_start integer NOT NULL CHECK (span_start >= 0),
  span_end integer NOT NULL CHECK (span_end > span_start),
  offset_unit text NOT NULL CHECK (offset_unit = 'unicode_code_points'),
  relation text NOT NULL CHECK (relation IN ('supports', 'contradicts', 'context')),
  PRIMARY KEY (dataset_kind, evidence_ref_id),
  FOREIGN KEY (trace_id, dataset_kind) REFERENCES waspada.traces (trace_id, dataset_kind),
  FOREIGN KEY (dataset_kind, report_revision_id, permitted_text_hash)
    REFERENCES waspada.report_revisions (dataset_kind, report_revision_id, permitted_text_hash)
);

CREATE TABLE waspada.evidence_origins (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  origin_id text NOT NULL,
  trace_id text NOT NULL,
  origin_kind text NOT NULL CHECK (origin_kind IN ('issuer_statement', 'operator_notice', 'reporter_observation', 'public_record', 'original_document', 'crowdsourced_observation', 'unknown')),
  actor_label text,
  source_id text REFERENCES waspada.source_registry (source_id),
  lineage_relation text NOT NULL CHECK (lineage_relation IN ('original', 'quoted', 'copied', 'reused_media', 'unknown')),
  independence_status text NOT NULL CHECK (independence_status IN ('established', 'dependent', 'unknown')),
  record_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(record_json) = 'object'),
  PRIMARY KEY (dataset_kind, origin_id),
  FOREIGN KEY (trace_id, dataset_kind) REFERENCES waspada.traces (trace_id, dataset_kind),
  CHECK (actor_label IS NULL OR length(actor_label) BETWEEN 1 AND 200)
);

CREATE TABLE waspada.origin_report_revisions (
  dataset_kind text NOT NULL,
  origin_id text NOT NULL,
  report_revision_id text NOT NULL,
  PRIMARY KEY (dataset_kind, origin_id, report_revision_id),
  FOREIGN KEY (dataset_kind, origin_id) REFERENCES waspada.evidence_origins (dataset_kind, origin_id),
  FOREIGN KEY (dataset_kind, report_revision_id) REFERENCES waspada.report_revisions (dataset_kind, report_revision_id)
);

CREATE TABLE waspada.origin_dependencies (
  dataset_kind text NOT NULL,
  origin_id text NOT NULL,
  depends_on_origin_id text NOT NULL,
  PRIMARY KEY (dataset_kind, origin_id, depends_on_origin_id),
  FOREIGN KEY (dataset_kind, origin_id) REFERENCES waspada.evidence_origins (dataset_kind, origin_id),
  FOREIGN KEY (dataset_kind, depends_on_origin_id) REFERENCES waspada.evidence_origins (dataset_kind, origin_id),
  CHECK (origin_id <> depends_on_origin_id)
);

CREATE TABLE waspada.origin_evidence (
  dataset_kind text NOT NULL,
  origin_id text NOT NULL,
  evidence_ref_id bigint NOT NULL,
  PRIMARY KEY (dataset_kind, origin_id, evidence_ref_id),
  FOREIGN KEY (dataset_kind, origin_id) REFERENCES waspada.evidence_origins (dataset_kind, origin_id),
  FOREIGN KEY (dataset_kind, evidence_ref_id) REFERENCES waspada.evidence_references (dataset_kind, evidence_ref_id)
);

CREATE TABLE waspada.geometries (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  geometry_id text NOT NULL,
  trace_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('incident_scene', 'affected_area', 'warning_boundary', 'route_segment', 'service_stop', 'facility', 'venue', 'service_area', 'approximate_place')),
  shape geometry(Geometry, 4326) NOT NULL,
  coordinate_reference_system text NOT NULL CHECK (coordinate_reference_system = 'OGC:CRS84'),
  precision_m double precision CHECK (precision_m IS NULL OR precision_m BETWEEN 0 AND 10000000),
  precision_basis text NOT NULL CHECK (precision_basis IN ('source_supplied', 'provider_accuracy', 'gazetteer_match', 'moderator_generalization', 'unknown')),
  display_label text,
  record_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(record_json) = 'object'),
  PRIMARY KEY (dataset_kind, geometry_id),
  FOREIGN KEY (trace_id, dataset_kind) REFERENCES waspada.traces (trace_id, dataset_kind),
  CHECK (GeometryType(shape) IN ('POINT', 'LINESTRING', 'POLYGON', 'MULTIPOINT', 'MULTILINESTRING', 'MULTIPOLYGON')),
  CHECK (ST_SRID(shape) = 4326 AND ST_IsValid(shape)),
  CHECK (display_label IS NULL OR length(display_label) BETWEEN 1 AND 200)
);
CREATE INDEX geometries_shape_gist ON waspada.geometries USING gist (shape);

CREATE TABLE waspada.geometry_evidence (
  dataset_kind text NOT NULL,
  geometry_id text NOT NULL,
  evidence_ref_id bigint NOT NULL,
  PRIMARY KEY (dataset_kind, geometry_id, evidence_ref_id),
  FOREIGN KEY (dataset_kind, geometry_id) REFERENCES waspada.geometries (dataset_kind, geometry_id),
  FOREIGN KEY (dataset_kind, evidence_ref_id) REFERENCES waspada.evidence_references (dataset_kind, evidence_ref_id)
);

CREATE TABLE waspada.evidence_chunks (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  chunk_id text NOT NULL,
  trace_id text NOT NULL,
  report_revision_id text NOT NULL,
  permitted_text_hash text NOT NULL CHECK (permitted_text_hash ~ '^[0-9a-f]{64}$'),
  span_start integer NOT NULL CHECK (span_start >= 0),
  span_end integer NOT NULL CHECK (span_end > span_start),
  offset_unit text NOT NULL CHECK (offset_unit = 'unicode_code_points'),
  chunker_version text NOT NULL,
  chunk_text_hash text NOT NULL CHECK (chunk_text_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('active', 'invalidated')),
  PRIMARY KEY (dataset_kind, chunk_id),
  UNIQUE (dataset_kind, chunk_id, permitted_text_hash),
  FOREIGN KEY (trace_id, dataset_kind) REFERENCES waspada.traces (trace_id, dataset_kind),
  FOREIGN KEY (dataset_kind, report_revision_id, permitted_text_hash)
    REFERENCES waspada.report_revisions (dataset_kind, report_revision_id, permitted_text_hash)
);
CREATE INDEX evidence_chunks_revision_idx ON waspada.evidence_chunks (dataset_kind, report_revision_id, status);

CREATE TABLE waspada.embedding_runs (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  embedding_run_id text NOT NULL,
  trace_id text NOT NULL,
  chunk_id text NOT NULL,
  capability text NOT NULL CHECK (capability = 'embedding'),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 120),
  model_version text NOT NULL CHECK (length(model_version) BETWEEN 1 AND 200),
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 100000),
  distance_metric text NOT NULL CHECK (distance_metric IN ('cosine', 'dot_product', 'euclidean')),
  vector_index_version text NOT NULL,
  input_text_hash text NOT NULL CHECK (input_text_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('available', 'invalidated', 'failed')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (dataset_kind, embedding_run_id),
  UNIQUE (dataset_kind, embedding_run_id, dimensions),
  FOREIGN KEY (trace_id, dataset_kind) REFERENCES waspada.traces (trace_id, dataset_kind),
  FOREIGN KEY (dataset_kind, chunk_id) REFERENCES waspada.evidence_chunks (dataset_kind, chunk_id)
);

-- Dimensions remain row data. Select an ANN index only after an embedding model is accepted.
CREATE TABLE waspada.embedding_vectors (
  dataset_kind text NOT NULL,
  embedding_run_id text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions > 0),
  embedding vector NOT NULL,
  PRIMARY KEY (dataset_kind, embedding_run_id),
  FOREIGN KEY (dataset_kind, embedding_run_id, dimensions)
    REFERENCES waspada.embedding_runs (dataset_kind, embedding_run_id, dimensions),
  CHECK (vector_dims(embedding) = dimensions)
);
CREATE INDEX embedding_vectors_dataset_dimensions_idx ON waspada.embedding_vectors (dataset_kind, dimensions);

CREATE TABLE waspada.extraction_results (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  candidate_id text NOT NULL,
  trace_id text NOT NULL,
  report_revision_id text NOT NULL,
  category text CHECK (category IS NULL OR category IN ('crime_personal_security', 'demonstrations_public_gatherings', 'crowds_major_events', 'violence_immediate_threats', 'disasters_weather', 'fires_infrastructure_hazards', 'transport_road_incidents', 'utilities_essential_services', 'health_environmental_advisories', 'group_specific_critical_notices')),
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
  PRIMARY KEY (dataset_kind, candidate_id),
  UNIQUE (dataset_kind, candidate_id, report_revision_id),
  FOREIGN KEY (trace_id, dataset_kind) REFERENCES waspada.traces (trace_id, dataset_kind),
  FOREIGN KEY (dataset_kind, report_revision_id) REFERENCES waspada.report_revisions (dataset_kind, report_revision_id)
);

CREATE TABLE waspada.extraction_evidence (
  dataset_kind text NOT NULL,
  candidate_id text NOT NULL,
  evidence_ref_id bigint NOT NULL,
  PRIMARY KEY (dataset_kind, candidate_id, evidence_ref_id),
  FOREIGN KEY (dataset_kind, candidate_id) REFERENCES waspada.extraction_results (dataset_kind, candidate_id),
  FOREIGN KEY (dataset_kind, evidence_ref_id) REFERENCES waspada.evidence_references (dataset_kind, evidence_ref_id)
);

CREATE TABLE waspada.grounding_contexts (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  context_id text NOT NULL,
  trace_id text NOT NULL,
  candidate_id text NOT NULL,
  retrieval_version text NOT NULL,
  index_version text NOT NULL,
  sufficient boolean NOT NULL,
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
  PRIMARY KEY (dataset_kind, context_id),
  UNIQUE (dataset_kind, context_id, candidate_id),
  FOREIGN KEY (trace_id, dataset_kind) REFERENCES waspada.traces (trace_id, dataset_kind),
  FOREIGN KEY (dataset_kind, candidate_id) REFERENCES waspada.extraction_results (dataset_kind, candidate_id)
);

CREATE TABLE waspada.grounding_evidence (
  dataset_kind text NOT NULL,
  context_id text NOT NULL,
  evidence_ref_id bigint NOT NULL,
  PRIMARY KEY (dataset_kind, context_id, evidence_ref_id),
  FOREIGN KEY (dataset_kind, context_id) REFERENCES waspada.grounding_contexts (dataset_kind, context_id),
  FOREIGN KEY (dataset_kind, evidence_ref_id) REFERENCES waspada.evidence_references (dataset_kind, evidence_ref_id)
);

CREATE TABLE waspada.investigation_requests (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  investigation_id text NOT NULL,
  trace_id text NOT NULL,
  candidate_id text NOT NULL,
  context_id text NOT NULL,
  event_id text,
  event_version integer,
  questions text[] NOT NULL CHECK (cardinality(questions) BETWEEN 1 AND 20),
  budget_policy_version text NOT NULL,
  limit_tool_attempts smallint NOT NULL CHECK (limit_tool_attempts BETWEEN 0 AND 5),
  limit_reasoning_turns smallint NOT NULL CHECK (limit_reasoning_turns BETWEEN 0 AND 4),
  limit_active_seconds integer NOT NULL CHECK (limit_active_seconds BETWEEN 0 AND 60),
  limit_model_tokens integer NOT NULL CHECK (limit_model_tokens BETWEEN 0 AND 12000),
  consumed_tool_attempts smallint NOT NULL DEFAULT 0 CHECK (consumed_tool_attempts >= 0),
  consumed_reasoning_turns smallint NOT NULL DEFAULT 0 CHECK (consumed_reasoning_turns >= 0),
  consumed_active_seconds integer NOT NULL DEFAULT 0 CHECK (consumed_active_seconds >= 0),
  consumed_model_tokens integer NOT NULL DEFAULT 0 CHECK (consumed_model_tokens >= 0),
  reserved_tool_attempts smallint NOT NULL DEFAULT 0 CHECK (reserved_tool_attempts >= 0),
  reserved_reasoning_turns smallint NOT NULL DEFAULT 0 CHECK (reserved_reasoning_turns >= 0),
  reserved_active_seconds integer NOT NULL DEFAULT 0 CHECK (reserved_active_seconds >= 0),
  reserved_model_tokens integer NOT NULL DEFAULT 0 CHECK (reserved_model_tokens >= 0),
  requested_at timestamptz NOT NULL,
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
  PRIMARY KEY (dataset_kind, investigation_id),
  UNIQUE (dataset_kind, investigation_id, candidate_id, context_id),
  FOREIGN KEY (trace_id, dataset_kind) REFERENCES waspada.traces (trace_id, dataset_kind),
  FOREIGN KEY (dataset_kind, context_id, candidate_id) REFERENCES waspada.grounding_contexts (dataset_kind, context_id, candidate_id),
  CHECK ((event_id IS NULL) = (event_version IS NULL)),
  CHECK (event_id IS NULL OR event_version > 0),
  CHECK (consumed_tool_attempts + reserved_tool_attempts <= limit_tool_attempts),
  CHECK (consumed_reasoning_turns + reserved_reasoning_turns <= limit_reasoning_turns),
  CHECK (consumed_active_seconds + reserved_active_seconds <= limit_active_seconds),
  CHECK (consumed_model_tokens + reserved_model_tokens <= limit_model_tokens)
);

CREATE TABLE waspada.investigation_checkpoints (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  checkpoint_id text NOT NULL,
  investigation_id text NOT NULL,
  checkpoint_version integer NOT NULL CHECK (checkpoint_version > 0),
  trace_id text NOT NULL,
  candidate_id text NOT NULL,
  context_id text NOT NULL,
  event_id text,
  event_version integer,
  case_status text NOT NULL CHECK (case_status IN ('open', 'paused', 'completed', 'stopped_for_review')),
  stop_reason text CHECK (stop_reason IS NULL OR stop_reason IN ('limit_exhausted', 'no_progress', 'material_conflict', 'tool_unavailable', 'awaiting_moderator', 'completed')),
  budget_policy_version text NOT NULL,
  limit_tool_attempts smallint NOT NULL CHECK (limit_tool_attempts BETWEEN 0 AND 5),
  limit_reasoning_turns smallint NOT NULL CHECK (limit_reasoning_turns BETWEEN 0 AND 4),
  limit_active_seconds integer NOT NULL CHECK (limit_active_seconds BETWEEN 0 AND 60),
  limit_model_tokens integer NOT NULL CHECK (limit_model_tokens BETWEEN 0 AND 12000),
  consumed_tool_attempts smallint NOT NULL DEFAULT 0 CHECK (consumed_tool_attempts >= 0),
  consumed_reasoning_turns smallint NOT NULL DEFAULT 0 CHECK (consumed_reasoning_turns >= 0),
  consumed_active_seconds integer NOT NULL DEFAULT 0 CHECK (consumed_active_seconds >= 0),
  consumed_model_tokens integer NOT NULL DEFAULT 0 CHECK (consumed_model_tokens >= 0),
  reserved_tool_attempts smallint NOT NULL DEFAULT 0 CHECK (reserved_tool_attempts >= 0),
  reserved_reasoning_turns smallint NOT NULL DEFAULT 0 CHECK (reserved_reasoning_turns >= 0),
  reserved_active_seconds integer NOT NULL DEFAULT 0 CHECK (reserved_active_seconds >= 0),
  reserved_model_tokens integer NOT NULL DEFAULT 0 CHECK (reserved_model_tokens >= 0),
  attempts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attempts) = 'array'),
  reasoning_runs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reasoning_runs) = 'array' AND jsonb_array_length(reasoning_runs) <= 4),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
  PRIMARY KEY (dataset_kind, checkpoint_id),
  UNIQUE (dataset_kind, investigation_id, checkpoint_version),
  FOREIGN KEY (trace_id, dataset_kind) REFERENCES waspada.traces (trace_id, dataset_kind),
  FOREIGN KEY (dataset_kind, investigation_id, candidate_id, context_id)
    REFERENCES waspada.investigation_requests (dataset_kind, investigation_id, candidate_id, context_id),
  FOREIGN KEY (dataset_kind, context_id, candidate_id) REFERENCES waspada.grounding_contexts (dataset_kind, context_id, candidate_id),
  CHECK ((event_id IS NULL) = (event_version IS NULL)),
  CHECK (event_id IS NULL OR event_version > 0),
  CHECK (consumed_tool_attempts + reserved_tool_attempts <= limit_tool_attempts),
  CHECK (consumed_reasoning_turns + reserved_reasoning_turns <= limit_reasoning_turns),
  CHECK (consumed_active_seconds + reserved_active_seconds <= limit_active_seconds),
  CHECK (consumed_model_tokens + reserved_model_tokens <= limit_model_tokens),
  CHECK (updated_at >= created_at),
  CHECK ((case_status IN ('open', 'paused') AND completed_at IS NULL) OR case_status NOT IN ('open', 'paused')),
  CHECK (case_status <> 'completed' OR (completed_at IS NOT NULL AND stop_reason = 'completed')),
  CHECK (case_status <> 'stopped_for_review' OR (completed_at IS NOT NULL AND stop_reason IN ('limit_exhausted', 'no_progress', 'material_conflict', 'tool_unavailable', 'awaiting_moderator')))
);

CREATE TABLE waspada.event_proposals (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  proposal_id text NOT NULL,
  trace_id text NOT NULL,
  candidate_id text NOT NULL,
  context_id text NOT NULL,
  event_id text,
  base_event_version integer,
  investigation_id text,
  proposed_at timestamptz NOT NULL,
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
  PRIMARY KEY (dataset_kind, proposal_id),
  FOREIGN KEY (trace_id, dataset_kind) REFERENCES waspada.traces (trace_id, dataset_kind),
  FOREIGN KEY (dataset_kind, context_id, candidate_id) REFERENCES waspada.grounding_contexts (dataset_kind, context_id, candidate_id),
  FOREIGN KEY (dataset_kind, investigation_id) REFERENCES waspada.investigation_requests (dataset_kind, investigation_id),
  CHECK ((event_id IS NULL) = (base_event_version IS NULL)),
  CHECK (event_id IS NULL OR base_event_version > 0)
);

CREATE TABLE waspada.proposal_claims (
  dataset_kind text NOT NULL,
  proposal_id text NOT NULL,
  claim_id text NOT NULL,
  support_assessment text NOT NULL CHECK (support_assessment IN ('supported', 'uncertain', 'disputed')),
  evidence_label text NOT NULL CHECK (evidence_label IN ('issuer_notice', 'attributed_report', 'independent_corroboration', 'crowdsourced_observation')),
  claim_text text NOT NULL CHECK (length(claim_text) BETWEEN 1 AND 2000),
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
  PRIMARY KEY (dataset_kind, proposal_id, claim_id),
  FOREIGN KEY (dataset_kind, proposal_id) REFERENCES waspada.event_proposals (dataset_kind, proposal_id)
);

CREATE TABLE waspada.proposal_claim_evidence (
  dataset_kind text NOT NULL,
  proposal_id text NOT NULL,
  claim_id text NOT NULL,
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('support', 'contradiction', 'context')),
  evidence_ref_id bigint NOT NULL,
  PRIMARY KEY (dataset_kind, proposal_id, claim_id, evidence_kind, evidence_ref_id),
  FOREIGN KEY (dataset_kind, proposal_id, claim_id) REFERENCES waspada.proposal_claims (dataset_kind, proposal_id, claim_id),
  FOREIGN KEY (dataset_kind, evidence_ref_id) REFERENCES waspada.evidence_references (dataset_kind, evidence_ref_id)
);

CREATE TABLE waspada.proposal_claim_origins (
  dataset_kind text NOT NULL,
  proposal_id text NOT NULL,
  claim_id text NOT NULL,
  origin_id text NOT NULL,
  PRIMARY KEY (dataset_kind, proposal_id, claim_id, origin_id),
  FOREIGN KEY (dataset_kind, proposal_id, claim_id) REFERENCES waspada.proposal_claims (dataset_kind, proposal_id, claim_id),
  FOREIGN KEY (dataset_kind, origin_id) REFERENCES waspada.evidence_origins (dataset_kind, origin_id)
);

CREATE TABLE waspada.publication_decisions (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  decision_id text NOT NULL,
  trace_id text NOT NULL,
  proposal_id text NOT NULL,
  policy_version text NOT NULL,
  event_id text,
  event_version integer,
  reviewer_id text,
  decided_at timestamptz NOT NULL,
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
  PRIMARY KEY (dataset_kind, decision_id),
  UNIQUE (dataset_kind, decision_id, event_id, event_version),
  UNIQUE (dataset_kind, decision_id, proposal_id),
  FOREIGN KEY (trace_id, dataset_kind) REFERENCES waspada.traces (trace_id, dataset_kind),
  FOREIGN KEY (dataset_kind, proposal_id) REFERENCES waspada.event_proposals (dataset_kind, proposal_id),
  CHECK ((event_id IS NULL) = (event_version IS NULL)),
  CHECK (event_id IS NULL OR event_version > 0)
);

CREATE TABLE waspada.publication_claim_decisions (
  dataset_kind text NOT NULL,
  decision_id text NOT NULL,
  proposal_id text NOT NULL,
  claim_id text NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('publish', 'review', 'reject', 'retract')),
  reason_codes text[] NOT NULL CHECK (cardinality(reason_codes) > 0),
  PRIMARY KEY (dataset_kind, decision_id, claim_id),
  FOREIGN KEY (dataset_kind, decision_id, proposal_id)
    REFERENCES waspada.publication_decisions (dataset_kind, decision_id, proposal_id),
  FOREIGN KEY (dataset_kind, proposal_id, claim_id)
    REFERENCES waspada.proposal_claims (dataset_kind, proposal_id, claim_id)
);

CREATE TABLE waspada.publication_decision_evidence (
  dataset_kind text NOT NULL,
  decision_id text NOT NULL,
  claim_id text NOT NULL,
  evidence_ref_id bigint NOT NULL,
  PRIMARY KEY (dataset_kind, decision_id, claim_id, evidence_ref_id),
  FOREIGN KEY (dataset_kind, decision_id, claim_id)
    REFERENCES waspada.publication_claim_decisions (dataset_kind, decision_id, claim_id),
  FOREIGN KEY (dataset_kind, evidence_ref_id) REFERENCES waspada.evidence_references (dataset_kind, evidence_ref_id)
);

CREATE TABLE waspada.event_versions (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  event_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  trace_id text NOT NULL,
  supersedes_version integer,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
  category text NOT NULL CHECK (category IN ('crime_personal_security', 'demonstrations_public_gatherings', 'crowds_major_events', 'violence_immediate_threats', 'disasters_weather', 'fires_infrastructure_hazards', 'transport_road_incidents', 'utilities_essential_services', 'health_environmental_advisories', 'group_specific_critical_notices')),
  lifecycle text NOT NULL CHECK (lifecycle IN ('planned', 'ongoing', 'resolved', 'cancelled', 'unknown')),
  publication_status text NOT NULL CHECK (publication_status IN ('published', 'withdrawn')),
  withdrawal_reason text CHECK (withdrawal_reason IS NULL OR withdrawal_reason IN ('source_retracted', 'evidence_ineligible', 'incorrect_event_match', 'privacy_removal', 'duplicate', 'other')),
  publication_decision_id text NOT NULL,
  published_at timestamptz,
  withdrawn_at timestamptz,
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
  PRIMARY KEY (dataset_kind, event_id, version),
  UNIQUE (dataset_kind, event_id, version, publication_status),
  FOREIGN KEY (trace_id, dataset_kind) REFERENCES waspada.traces (trace_id, dataset_kind),
  FOREIGN KEY (dataset_kind, event_id, supersedes_version)
    REFERENCES waspada.event_versions (dataset_kind, event_id, version),
  CHECK ((version = 1 AND supersedes_version IS NULL) OR (version > 1 AND supersedes_version = version - 1)),
  CHECK (jsonb_typeof(record_json->'claims') = 'array'),
  CHECK (jsonb_typeof(record_json->'impact_refs') = 'array'),
  CHECK (
    (publication_status = 'published'
      AND jsonb_array_length(record_json->'claims') >= 1
      AND withdrawal_reason IS NULL
      AND published_at IS NOT NULL
      AND withdrawn_at IS NULL)
    OR
    (publication_status = 'withdrawn'
      AND jsonb_array_length(record_json->'claims') = 0
      AND jsonb_array_length(record_json->'impact_refs') = 0
      AND withdrawal_reason IS NOT NULL
      AND published_at IS NULL
      AND withdrawn_at IS NOT NULL)
  )
);

CREATE TABLE waspada.event_claims (
  dataset_kind text NOT NULL,
  event_id text NOT NULL,
  event_version integer NOT NULL,
  claim_id text NOT NULL,
  publication_status text NOT NULL DEFAULT 'published' CHECK (publication_status = 'published'),
  claim_text text NOT NULL CHECK (length(claim_text) BETWEEN 1 AND 2000),
  evidence_label text NOT NULL CHECK (evidence_label IN ('issuer_notice', 'attributed_report', 'independent_corroboration', 'crowdsourced_observation')),
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
  PRIMARY KEY (dataset_kind, event_id, event_version, claim_id),
  FOREIGN KEY (dataset_kind, event_id, event_version, publication_status)
    REFERENCES waspada.event_versions (dataset_kind, event_id, version, publication_status)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE waspada.event_claim_evidence (
  dataset_kind text NOT NULL,
  event_id text NOT NULL,
  event_version integer NOT NULL,
  claim_id text NOT NULL,
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('support', 'contradiction', 'context')),
  evidence_ref_id bigint NOT NULL,
  PRIMARY KEY (dataset_kind, event_id, event_version, claim_id, evidence_kind, evidence_ref_id),
  FOREIGN KEY (dataset_kind, event_id, event_version, claim_id)
    REFERENCES waspada.event_claims (dataset_kind, event_id, event_version, claim_id),
  FOREIGN KEY (dataset_kind, evidence_ref_id) REFERENCES waspada.evidence_references (dataset_kind, evidence_ref_id)
);

CREATE TABLE waspada.event_claim_origins (
  dataset_kind text NOT NULL,
  event_id text NOT NULL,
  event_version integer NOT NULL,
  claim_id text NOT NULL,
  origin_id text NOT NULL,
  PRIMARY KEY (dataset_kind, event_id, event_version, claim_id, origin_id),
  FOREIGN KEY (dataset_kind, event_id, event_version, claim_id)
    REFERENCES waspada.event_claims (dataset_kind, event_id, event_version, claim_id),
  FOREIGN KEY (dataset_kind, origin_id) REFERENCES waspada.evidence_origins (dataset_kind, origin_id)
);

CREATE TABLE waspada.event_claim_geometries (
  dataset_kind text NOT NULL,
  event_id text NOT NULL,
  event_version integer NOT NULL,
  claim_id text NOT NULL,
  geometry_id text NOT NULL,
  PRIMARY KEY (dataset_kind, event_id, event_version, claim_id, geometry_id),
  FOREIGN KEY (dataset_kind, event_id, event_version, claim_id)
    REFERENCES waspada.event_claims (dataset_kind, event_id, event_version, claim_id),
  FOREIGN KEY (dataset_kind, geometry_id) REFERENCES waspada.geometries (dataset_kind, geometry_id)
);

CREATE TABLE waspada.impact_versions (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  impact_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  trace_id text NOT NULL,
  event_id text NOT NULL,
  event_version integer NOT NULL,
  impact_type text NOT NULL CHECK (impact_type IN ('road_closure', 'traffic_diversion', 'transport_service_disruption', 'facility_closure', 'utility_outage', 'hazard_observation', 'public_access_restriction', 'event_attendance', 'audience_notice', 'other')),
  lifecycle text NOT NULL CHECK (lifecycle IN ('planned', 'ongoing', 'resolved', 'cancelled', 'unknown')),
  published_at timestamptz NOT NULL,
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
  PRIMARY KEY (dataset_kind, impact_id, version),
  UNIQUE (dataset_kind, event_id, impact_id, version),
  UNIQUE (dataset_kind, impact_id, version, event_id, event_version),
  FOREIGN KEY (trace_id, dataset_kind) REFERENCES waspada.traces (trace_id, dataset_kind),
  FOREIGN KEY (dataset_kind, event_id, event_version) REFERENCES waspada.event_versions (dataset_kind, event_id, version)
);

CREATE TABLE waspada.impact_claim_support (
  dataset_kind text NOT NULL,
  impact_id text NOT NULL,
  impact_version integer NOT NULL,
  event_id text NOT NULL,
  event_version integer NOT NULL,
  claim_id text NOT NULL,
  PRIMARY KEY (dataset_kind, impact_id, impact_version, claim_id),
  FOREIGN KEY (dataset_kind, impact_id, impact_version) REFERENCES waspada.impact_versions (dataset_kind, impact_id, version),
  FOREIGN KEY (dataset_kind, event_id, event_version, claim_id)
    REFERENCES waspada.event_claims (dataset_kind, event_id, event_version, claim_id),
  FOREIGN KEY (dataset_kind, impact_id, impact_version, event_id, event_version)
    REFERENCES waspada.impact_versions (dataset_kind, impact_id, version, event_id, event_version)
);

CREATE TABLE waspada.event_impact_refs (
  dataset_kind text NOT NULL,
  event_id text NOT NULL,
  event_version integer NOT NULL,
  impact_id text NOT NULL,
  impact_version integer NOT NULL,
  PRIMARY KEY (dataset_kind, event_id, event_version, impact_id, impact_version),
  FOREIGN KEY (dataset_kind, event_id, event_version) REFERENCES waspada.event_versions (dataset_kind, event_id, version),
  FOREIGN KEY (dataset_kind, event_id, impact_id, impact_version)
    REFERENCES waspada.impact_versions (dataset_kind, event_id, impact_id, version)
);

CREATE TABLE waspada.grounding_candidate_events (
  dataset_kind text NOT NULL,
  context_id text NOT NULL,
  event_id text NOT NULL,
  event_version integer NOT NULL,
  PRIMARY KEY (dataset_kind, context_id, event_id, event_version),
  FOREIGN KEY (dataset_kind, context_id) REFERENCES waspada.grounding_contexts (dataset_kind, context_id),
  FOREIGN KEY (dataset_kind, event_id, event_version) REFERENCES waspada.event_versions (dataset_kind, event_id, version)
);

CREATE TABLE waspada.grounding_prior_decisions (
  dataset_kind text NOT NULL,
  context_id text NOT NULL,
  decision_id text NOT NULL,
  PRIMARY KEY (dataset_kind, context_id, decision_id),
  FOREIGN KEY (dataset_kind, context_id) REFERENCES waspada.grounding_contexts (dataset_kind, context_id),
  FOREIGN KEY (dataset_kind, decision_id) REFERENCES waspada.publication_decisions (dataset_kind, decision_id)
);

ALTER TABLE waspada.investigation_requests
  ADD CONSTRAINT investigation_event_target_fk
  FOREIGN KEY (dataset_kind, event_id, event_version)
  REFERENCES waspada.event_versions (dataset_kind, event_id, version);

ALTER TABLE waspada.investigation_checkpoints
  ADD CONSTRAINT checkpoint_event_target_fk
  FOREIGN KEY (dataset_kind, event_id, event_version)
  REFERENCES waspada.event_versions (dataset_kind, event_id, version);

ALTER TABLE waspada.event_proposals
  ADD CONSTRAINT proposal_event_target_fk
  FOREIGN KEY (dataset_kind, event_id, base_event_version)
  REFERENCES waspada.event_versions (dataset_kind, event_id, version);

ALTER TABLE waspada.publication_decisions
  ADD CONSTRAINT decision_event_target_fk
  FOREIGN KEY (dataset_kind, event_id, event_version)
  REFERENCES waspada.event_versions (dataset_kind, event_id, version)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE waspada.event_versions
  ADD CONSTRAINT event_publication_decision_fk
  FOREIGN KEY (dataset_kind, publication_decision_id, event_id, version)
  REFERENCES waspada.publication_decisions (dataset_kind, decision_id, event_id, event_version)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE waspada.dataset_namespace_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  configured_at timestamptz NOT NULL DEFAULT now()
);

CREATE VIEW waspada.public_event_versions WITH (security_barrier = true) AS
SELECT ev.dataset_kind, ev.event_id, ev.version, ev.title, ev.summary, ev.category,
       ev.lifecycle, ev.record_json
FROM waspada.event_versions AS ev
JOIN waspada.dataset_namespace_config AS cfg ON cfg.dataset_kind = ev.dataset_kind
WHERE ev.publication_status = 'published'
  AND NOT EXISTS (
    SELECT 1
    FROM waspada.event_versions AS newer
    WHERE newer.dataset_kind = ev.dataset_kind
      AND newer.event_id = ev.event_id
      AND newer.version > ev.version
  );

CREATE VIEW waspada.public_event_impacts WITH (security_barrier = true) AS
SELECT current_event.dataset_kind, current_event.event_id, current_event.version AS event_version,
       impact.impact_id, impact.version AS impact_version, impact.impact_type,
       impact.lifecycle, impact.record_json
FROM waspada.public_event_versions AS current_event
JOIN waspada.event_impact_refs AS ref
  ON ref.dataset_kind = current_event.dataset_kind
 AND ref.event_id = current_event.event_id
 AND ref.event_version = current_event.version
JOIN waspada.impact_versions AS impact
  ON impact.dataset_kind = ref.dataset_kind
 AND impact.event_id = ref.event_id
 AND impact.impact_id = ref.impact_id
 AND impact.version = ref.impact_version;

CREATE FUNCTION waspada.reject_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER report_revisions_append_only
  BEFORE UPDATE OR DELETE ON waspada.report_revisions
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER evidence_references_append_only
  BEFORE UPDATE OR DELETE ON waspada.evidence_references
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER evidence_origins_append_only
  BEFORE UPDATE OR DELETE ON waspada.evidence_origins
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER origin_report_revisions_append_only
  BEFORE UPDATE OR DELETE ON waspada.origin_report_revisions
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER origin_dependencies_append_only
  BEFORE UPDATE OR DELETE ON waspada.origin_dependencies
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER origin_evidence_append_only
  BEFORE UPDATE OR DELETE ON waspada.origin_evidence
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER geometries_append_only
  BEFORE UPDATE OR DELETE ON waspada.geometries
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER geometry_evidence_append_only
  BEFORE UPDATE OR DELETE ON waspada.geometry_evidence
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER extraction_results_append_only
  BEFORE UPDATE OR DELETE ON waspada.extraction_results
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER extraction_evidence_append_only
  BEFORE UPDATE OR DELETE ON waspada.extraction_evidence
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER grounding_contexts_append_only
  BEFORE UPDATE OR DELETE ON waspada.grounding_contexts
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER grounding_evidence_append_only
  BEFORE UPDATE OR DELETE ON waspada.grounding_evidence
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER investigation_requests_append_only
  BEFORE UPDATE OR DELETE ON waspada.investigation_requests
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER investigation_checkpoints_append_only
  BEFORE UPDATE OR DELETE ON waspada.investigation_checkpoints
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER event_proposals_append_only
  BEFORE UPDATE OR DELETE ON waspada.event_proposals
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER proposal_claims_append_only
  BEFORE UPDATE OR DELETE ON waspada.proposal_claims
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER proposal_claim_evidence_append_only
  BEFORE UPDATE OR DELETE ON waspada.proposal_claim_evidence
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER proposal_claim_origins_append_only
  BEFORE UPDATE OR DELETE ON waspada.proposal_claim_origins
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER publication_decisions_append_only
  BEFORE UPDATE OR DELETE ON waspada.publication_decisions
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER publication_claim_decisions_append_only
  BEFORE UPDATE OR DELETE ON waspada.publication_claim_decisions
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER publication_decision_evidence_append_only
  BEFORE UPDATE OR DELETE ON waspada.publication_decision_evidence
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER event_versions_append_only
  BEFORE UPDATE OR DELETE ON waspada.event_versions
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER event_claims_append_only
  BEFORE UPDATE OR DELETE ON waspada.event_claims
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER event_claim_evidence_append_only
  BEFORE UPDATE OR DELETE ON waspada.event_claim_evidence
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER event_claim_origins_append_only
  BEFORE UPDATE OR DELETE ON waspada.event_claim_origins
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER event_claim_geometries_append_only
  BEFORE UPDATE OR DELETE ON waspada.event_claim_geometries
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER impact_versions_append_only
  BEFORE UPDATE OR DELETE ON waspada.impact_versions
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER impact_claim_support_append_only
  BEFORE UPDATE OR DELETE ON waspada.impact_claim_support
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER event_impact_refs_append_only
  BEFORE UPDATE OR DELETE ON waspada.event_impact_refs
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER grounding_candidate_events_append_only
  BEFORE UPDATE OR DELETE ON waspada.grounding_candidate_events
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER grounding_prior_decisions_append_only
  BEFORE UPDATE OR DELETE ON waspada.grounding_prior_decisions
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER audit_records_append_only
  BEFORE UPDATE OR DELETE ON waspada.audit_records
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waspada_public_reader') THEN
    CREATE ROLE waspada_public_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waspada_l1_pipeline') THEN
    CREATE ROLE waspada_l1_pipeline NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waspada_l4_publication_writer') THEN
    CREATE ROLE waspada_l4_publication_writer NOLOGIN;
  END IF;
END;
$$;

REVOKE ALL ON SCHEMA waspada FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA waspada FROM PUBLIC;
GRANT USAGE ON SCHEMA waspada TO waspada_public_reader, waspada_l1_pipeline, waspada_l4_publication_writer;

GRANT SELECT ON waspada.public_event_versions, waspada.public_event_impacts TO waspada_public_reader;

GRANT SELECT ON waspada.source_registry, waspada.report_revisions TO waspada_l1_pipeline;
GRANT INSERT ON waspada.report_revisions, waspada.evidence_references,
  waspada.evidence_origins, waspada.origin_report_revisions, waspada.origin_dependencies,
  waspada.origin_evidence, waspada.geometries, waspada.geometry_evidence,
  waspada.evidence_chunks, waspada.embedding_runs, waspada.embedding_vectors,
  waspada.extraction_results, waspada.extraction_evidence TO waspada_l1_pipeline;
GRANT UPDATE (status) ON waspada.evidence_chunks, waspada.embedding_runs TO waspada_l1_pipeline;
GRANT USAGE, SELECT ON SEQUENCE waspada.evidence_references_evidence_ref_id_seq TO waspada_l1_pipeline;
GRANT INSERT, SELECT ON waspada.traces, waspada.audit_records TO waspada_l1_pipeline;
GRANT UPDATE (ended_at, outcome, metadata) ON waspada.traces TO waspada_l1_pipeline;

GRANT SELECT ON waspada.source_registry, waspada.report_revisions, waspada.evidence_references,
  waspada.evidence_origins, waspada.geometries, waspada.grounding_contexts,
  waspada.investigation_requests, waspada.investigation_checkpoints,
  waspada.event_proposals, waspada.proposal_claims, waspada.event_versions,
  waspada.event_claims, waspada.impact_versions TO waspada_l4_publication_writer;
GRANT INSERT ON waspada.publication_decisions, waspada.publication_claim_decisions,
  waspada.publication_decision_evidence, waspada.event_versions, waspada.event_claims,
  waspada.event_claim_evidence, waspada.event_claim_origins, waspada.event_claim_geometries,
  waspada.impact_versions, waspada.impact_claim_support, waspada.event_impact_refs TO waspada_l4_publication_writer;
GRANT UPDATE (health_status, last_checked_at, last_success_at)
  ON waspada.source_registry TO waspada_l1_pipeline;
GRANT UPDATE (registry_version, display_name, remit, access_method, approved_hosts,
  access_restrictions, reuse_basis, registry_status, approval_status,
  auto_acquisition_enabled, auto_publication_policy, polling_interval_seconds,
  trace_id)
  ON waspada.source_registry TO waspada_l4_publication_writer;
GRANT INSERT, SELECT ON waspada.traces, waspada.audit_records TO waspada_l4_publication_writer;
GRANT UPDATE (ended_at, outcome, metadata) ON waspada.traces TO waspada_l4_publication_writer;
