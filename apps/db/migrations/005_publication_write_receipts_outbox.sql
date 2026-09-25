-- PUB-WRITE-CORE: local, manually approved publication transaction.
-- This migration adds durable idempotency receipts and a payload-minimal outbox.

CREATE TABLE waspada.publication_write_receipts (
  dataset_kind text NOT NULL CHECK (dataset_kind = 'live'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  decision_id text NOT NULL,
  event_id text NOT NULL,
  event_version integer NOT NULL CHECK (event_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_kind, idempotency_key),
  FOREIGN KEY (dataset_kind, decision_id)
    REFERENCES waspada.publication_decisions (dataset_kind, decision_id),
  FOREIGN KEY (dataset_kind, event_id, event_version)
    REFERENCES waspada.event_versions (dataset_kind, event_id, version)
);

CREATE TABLE waspada.publication_outbox (
  outbox_id text PRIMARY KEY CHECK (length(outbox_id) BETWEEN 1 AND 200),
  dataset_kind text NOT NULL CHECK (dataset_kind = 'live'),
  event_id text NOT NULL,
  event_version integer NOT NULL CHECK (event_version > 0),
  event_kind text NOT NULL CHECK (event_kind = 'event_version_published'),
  trace_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_kind, event_id, event_version),
  FOREIGN KEY (dataset_kind, event_id, event_version)
    REFERENCES waspada.event_versions (dataset_kind, event_id, version),
  FOREIGN KEY (trace_id, dataset_kind)
    REFERENCES waspada.traces (trace_id, dataset_kind)
);

CREATE TRIGGER publication_write_receipts_append_only
  BEFORE UPDATE OR DELETE ON waspada.publication_write_receipts
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();

CREATE TRIGGER publication_outbox_append_only
  BEFORE UPDATE OR DELETE ON waspada.publication_outbox
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();

-- Replace the old whole-table L4 reads on publication inputs with only the
-- columns used by the transaction. Existing source-policy UPDATE grants,
-- trace/audit grants, and acquisition-job grants remain untouched.
REVOKE SELECT ON TABLE
  waspada.source_registry,
  waspada.report_revisions,
  waspada.evidence_references,
  waspada.evidence_origins,
  waspada.geometries,
  waspada.grounding_contexts,
  waspada.investigation_requests,
  waspada.investigation_checkpoints,
  waspada.event_proposals,
  waspada.proposal_claims,
  waspada.event_versions,
  waspada.event_claims,
  waspada.impact_versions
FROM waspada_l4_publication_writer;

REVOKE ALL PRIVILEGES ON TABLE waspada.publication_write_receipts,
  waspada.publication_outbox
FROM PUBLIC, waspada_public_reader, waspada_l1_pipeline,
  waspada_l2_grounding_reader, waspada_l4_publication_writer;

GRANT SELECT (dataset_kind)
  ON TABLE waspada.dataset_namespace_config TO waspada_l4_publication_writer;

-- Preserve the existing L4 source-policy repository with its selected columns.
GRANT SELECT (
  source_id, trace_id, registry_version, display_name, source_kind,
  publisher_group_id, remit, access_method, approved_hosts,
  access_restrictions, reuse_basis, registry_status, approval_status,
  health_status, auto_acquisition_enabled, auto_publication_policy,
  polling_interval_seconds, last_checked_at, last_success_at
) ON TABLE waspada.source_registry TO waspada_l4_publication_writer;

GRANT SELECT (
  dataset_kind, proposal_id, trace_id, candidate_id, context_id,
  event_id, base_event_version, record_json
) ON TABLE waspada.event_proposals TO waspada_l4_publication_writer;

GRANT SELECT (
  dataset_kind, proposal_id, claim_id, support_assessment,
  evidence_label, claim_text, record_json
) ON TABLE waspada.proposal_claims TO waspada_l4_publication_writer;

GRANT SELECT (
  dataset_kind, proposal_id, claim_id, evidence_kind, evidence_ref_id
) ON TABLE waspada.proposal_claim_evidence TO waspada_l4_publication_writer;

GRANT SELECT (
  dataset_kind, proposal_id, claim_id, origin_id
) ON TABLE waspada.proposal_claim_origins TO waspada_l4_publication_writer;

GRANT SELECT (dataset_kind, context_id, evidence_ref_id)
  ON TABLE waspada.grounding_evidence TO waspada_l4_publication_writer;

GRANT SELECT (
  dataset_kind, evidence_ref_id, report_revision_id, permitted_text_hash,
  span_start, span_end, offset_unit, relation
) ON TABLE waspada.evidence_references TO waspada_l4_publication_writer;

GRANT SELECT (dataset_kind, geometry_id)
  ON TABLE waspada.geometries TO waspada_l4_publication_writer;

GRANT SELECT (dataset_kind, geometry_id, evidence_ref_id)
  ON TABLE waspada.geometry_evidence TO waspada_l4_publication_writer;

GRANT SELECT (dataset_kind, event_id, version)
  ON TABLE waspada.event_versions TO waspada_l4_publication_writer;

GRANT SELECT (dataset_kind, impact_id, version)
  ON TABLE waspada.impact_versions TO waspada_l4_publication_writer;

GRANT SELECT (
  dataset_kind, idempotency_key, request_fingerprint, decision_id, event_id, event_version
) ON TABLE waspada.publication_write_receipts TO waspada_l4_publication_writer;

GRANT INSERT (
  dataset_kind, idempotency_key, request_fingerprint, decision_id,
  event_id, event_version
) ON TABLE waspada.publication_write_receipts TO waspada_l4_publication_writer;

GRANT INSERT (
  outbox_id, dataset_kind, event_id, event_version, event_kind, trace_id, occurred_at
) ON TABLE waspada.publication_outbox TO waspada_l4_publication_writer;
