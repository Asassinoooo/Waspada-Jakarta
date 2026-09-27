-- MOD-01-WRITER-ROLE-CORE: isolated capability for the atomic manual publication transaction.
-- This role is not a login and is intentionally not a member of the shared L4 role.
CREATE ROLE waspada_l4_moderator_publication_writer
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

REVOKE ALL PRIVILEGES ON SCHEMA waspada
  FROM waspada_l4_moderator_publication_writer;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA waspada
  FROM waspada_l4_moderator_publication_writer;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA waspada
  FROM waspada_l4_moderator_publication_writer;
GRANT USAGE ON SCHEMA waspada TO waspada_l4_moderator_publication_writer;

-- Read only the configured namespace and the trace identity needed for validation.
GRANT SELECT (dataset_kind) ON TABLE waspada.dataset_namespace_config
  TO waspada_l4_moderator_publication_writer;
GRANT SELECT (trace_id, dataset_kind) ON TABLE waspada.traces
  TO waspada_l4_moderator_publication_writer;

-- Exact normalized proposal, evidence, geometry, version, and replay inputs read by SqlPublicationWriter.
GRANT SELECT (
  dataset_kind, proposal_id, trace_id, candidate_id, context_id,
  event_id, base_event_version, record_json
) ON TABLE waspada.event_proposals
  TO waspada_l4_moderator_publication_writer;
GRANT SELECT (
  dataset_kind, proposal_id, claim_id, support_assessment,
  evidence_label, claim_text, record_json
) ON TABLE waspada.proposal_claims
  TO waspada_l4_moderator_publication_writer;
GRANT SELECT (
  dataset_kind, proposal_id, claim_id, evidence_kind, evidence_ref_id
) ON TABLE waspada.proposal_claim_evidence
  TO waspada_l4_moderator_publication_writer;
GRANT SELECT (dataset_kind, proposal_id, claim_id, origin_id)
  ON TABLE waspada.proposal_claim_origins
  TO waspada_l4_moderator_publication_writer;
GRANT SELECT (dataset_kind, context_id, evidence_ref_id)
  ON TABLE waspada.grounding_evidence
  TO waspada_l4_moderator_publication_writer;
GRANT SELECT (
  dataset_kind, evidence_ref_id, report_revision_id, permitted_text_hash,
  span_start, span_end, offset_unit, relation
) ON TABLE waspada.evidence_references
  TO waspada_l4_moderator_publication_writer;
GRANT SELECT (dataset_kind, geometry_id, evidence_ref_id)
  ON TABLE waspada.geometry_evidence
  TO waspada_l4_moderator_publication_writer;
GRANT SELECT (dataset_kind, geometry_id)
  ON TABLE waspada.geometries
  TO waspada_l4_moderator_publication_writer;
GRANT SELECT (dataset_kind, event_id, version)
  ON TABLE waspada.event_versions
  TO waspada_l4_moderator_publication_writer;
GRANT SELECT (dataset_kind, impact_id, version)
  ON TABLE waspada.impact_versions
  TO waspada_l4_moderator_publication_writer;
GRANT SELECT (
  dataset_kind, idempotency_key, request_fingerprint, decision_id, event_id, event_version
) ON TABLE waspada.publication_write_receipts
  TO waspada_l4_moderator_publication_writer;

-- Exact append-only rows emitted by SqlPublicationWriter.
GRANT INSERT (
  dataset_kind, decision_id, trace_id, proposal_id, policy_version,
  event_id, event_version, reviewer_id, decided_at, record_json
) ON TABLE waspada.publication_decisions
  TO waspada_l4_moderator_publication_writer;
GRANT INSERT (
  dataset_kind, decision_id, proposal_id, claim_id, disposition, reason_codes
) ON TABLE waspada.publication_claim_decisions
  TO waspada_l4_moderator_publication_writer;
GRANT INSERT (dataset_kind, decision_id, claim_id, evidence_ref_id)
  ON TABLE waspada.publication_decision_evidence
  TO waspada_l4_moderator_publication_writer;
GRANT INSERT (
  dataset_kind, event_id, version, trace_id, supersedes_version, title, summary,
  category, lifecycle, publication_status, withdrawal_reason,
  publication_decision_id, published_at, withdrawn_at, record_json
) ON TABLE waspada.event_versions
  TO waspada_l4_moderator_publication_writer;
GRANT INSERT (
  dataset_kind, event_id, event_version, claim_id, publication_status,
  claim_text, evidence_label, record_json
) ON TABLE waspada.event_claims
  TO waspada_l4_moderator_publication_writer;
GRANT INSERT (
  dataset_kind, event_id, event_version, claim_id, evidence_kind, evidence_ref_id
) ON TABLE waspada.event_claim_evidence
  TO waspada_l4_moderator_publication_writer;
GRANT INSERT (dataset_kind, event_id, event_version, claim_id, origin_id)
  ON TABLE waspada.event_claim_origins
  TO waspada_l4_moderator_publication_writer;
GRANT INSERT (dataset_kind, event_id, event_version, claim_id, geometry_id)
  ON TABLE waspada.event_claim_geometries
  TO waspada_l4_moderator_publication_writer;
GRANT INSERT (
  dataset_kind, impact_id, version, trace_id, event_id, event_version,
  impact_type, lifecycle, published_at, record_json
) ON TABLE waspada.impact_versions
  TO waspada_l4_moderator_publication_writer;
GRANT INSERT (
  dataset_kind, impact_id, impact_version, event_id, event_version, claim_id
) ON TABLE waspada.impact_claim_support
  TO waspada_l4_moderator_publication_writer;
GRANT INSERT (dataset_kind, event_id, event_version, impact_id, impact_version)
  ON TABLE waspada.event_impact_refs
  TO waspada_l4_moderator_publication_writer;
GRANT INSERT (
  dataset_kind, audit_id, trace_id, occurred_at, actor_id, action,
  entity_type, entity_id, reason, details
) ON TABLE waspada.audit_records
  TO waspada_l4_moderator_publication_writer;
GRANT INSERT (
  outbox_id, dataset_kind, event_id, event_version, event_kind, trace_id, occurred_at
) ON TABLE waspada.publication_outbox
  TO waspada_l4_moderator_publication_writer;
GRANT INSERT (
  dataset_kind, idempotency_key, request_fingerprint, decision_id, event_id, event_version
) ON TABLE waspada.publication_write_receipts
  TO waspada_l4_moderator_publication_writer;