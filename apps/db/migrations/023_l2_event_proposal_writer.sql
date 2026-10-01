-- L2-PROPOSAL-PERSIST-CORE: widen only private draft claim capacity and add its isolated writer.
ALTER TABLE waspada.proposal_claims
  DROP CONSTRAINT IF EXISTS proposal_claims_evidence_label_check;
ALTER TABLE waspada.proposal_claims
  ADD CONSTRAINT proposal_claims_evidence_label_check
  CHECK (evidence_label IN ('issuer_notice', 'attributed_report', 'independent_corroboration', 'crowdsourced_observation', 'under_review'));
ALTER TABLE waspada.proposal_claims
  DROP CONSTRAINT IF EXISTS proposal_claims_claim_text_check;
ALTER TABLE waspada.proposal_claims
  ADD CONSTRAINT proposal_claims_claim_text_check CHECK (length(claim_text) BETWEEN 1 AND 4000);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waspada_l2_proposal_writer') THEN
    CREATE ROLE waspada_l2_proposal_writer NOLOGIN;
  END IF;
END;
$$;

ALTER ROLE waspada_l2_proposal_writer
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- Clamp a pre-existing role to this writer's standalone capability.
REVOKE ALL PRIVILEGES ON SCHEMA waspada FROM waspada_l2_proposal_writer;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA waspada FROM waspada_l2_proposal_writer;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA waspada FROM waspada_l2_proposal_writer;

DO $$
DECLARE membership record;
BEGIN
  FOR membership IN
    SELECT granted.rolname AS granted_role
    FROM pg_auth_members AS m JOIN pg_roles AS granted ON granted.oid = m.roleid
    WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'waspada_l2_proposal_writer')
  LOOP
    EXECUTE format('REVOKE %I FROM waspada_l2_proposal_writer', membership.granted_role);
  END LOOP;
  FOR membership IN
    SELECT member_role.rolname AS member_role
    FROM pg_auth_members AS m JOIN pg_roles AS member_role ON member_role.oid = m.member
    WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'waspada_l2_proposal_writer')
  LOOP
    EXECUTE format('REVOKE waspada_l2_proposal_writer FROM %I', membership.member_role);
  END LOOP;
END;
$$;

GRANT USAGE ON SCHEMA waspada TO waspada_l2_proposal_writer;
GRANT SELECT (trace_id, dataset_kind) ON TABLE waspada.traces TO waspada_l2_proposal_writer;
GRANT SELECT (dataset_kind, candidate_id) ON TABLE waspada.extraction_results TO waspada_l2_proposal_writer;
GRANT SELECT (dataset_kind, context_id, trace_id, candidate_id) ON TABLE waspada.grounding_contexts TO waspada_l2_proposal_writer;
GRANT SELECT (dataset_kind, context_id, evidence_ref_id) ON TABLE waspada.grounding_evidence TO waspada_l2_proposal_writer;
GRANT SELECT (dataset_kind, evidence_ref_id, report_revision_id, permitted_text_hash, span_start, span_end, offset_unit, relation)
  ON TABLE waspada.evidence_references TO waspada_l2_proposal_writer;
GRANT SELECT (dataset_kind, origin_id) ON TABLE waspada.evidence_origins TO waspada_l2_proposal_writer;
GRANT SELECT (dataset_kind, origin_id, evidence_ref_id) ON TABLE waspada.origin_evidence TO waspada_l2_proposal_writer;
GRANT SELECT (dataset_kind, event_id, version) ON TABLE waspada.event_versions TO waspada_l2_proposal_writer;
GRANT SELECT (dataset_kind, context_id, event_id, event_version) ON TABLE waspada.grounding_candidate_events TO waspada_l2_proposal_writer;
GRANT SELECT (dataset_kind, investigation_id, trace_id, candidate_id, context_id, event_id, event_version)
  ON TABLE waspada.investigation_requests TO waspada_l2_proposal_writer;
GRANT SELECT (dataset_kind, investigation_id, trace_id, candidate_id, context_id, event_id, event_version, checkpoint_id)
  ON TABLE waspada.investigation_checkpoints TO waspada_l2_proposal_writer;

GRANT SELECT (dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id, base_event_version, investigation_id, proposed_at, record_json)
  ON TABLE waspada.event_proposals TO waspada_l2_proposal_writer;
GRANT INSERT (dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id, base_event_version, investigation_id, proposed_at, record_json)
  ON TABLE waspada.event_proposals TO waspada_l2_proposal_writer;
GRANT SELECT (dataset_kind, proposal_id, claim_id, support_assessment, evidence_label, claim_text, record_json)
  ON TABLE waspada.proposal_claims TO waspada_l2_proposal_writer;
GRANT INSERT (dataset_kind, proposal_id, claim_id, support_assessment, evidence_label, claim_text, record_json)
  ON TABLE waspada.proposal_claims TO waspada_l2_proposal_writer;
GRANT SELECT (dataset_kind, proposal_id, claim_id, evidence_kind, evidence_ref_id),
      INSERT (dataset_kind, proposal_id, claim_id, evidence_kind, evidence_ref_id)
  ON TABLE waspada.proposal_claim_evidence TO waspada_l2_proposal_writer;
GRANT SELECT (dataset_kind, proposal_id, claim_id, origin_id),
      INSERT (dataset_kind, proposal_id, claim_id, origin_id)
  ON TABLE waspada.proposal_claim_origins TO waspada_l2_proposal_writer;
