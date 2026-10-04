-- LIFE-01 report-revision impact discovery: standalone read-only capability.
-- This reader follows normalized identifiers only; source text and publication payloads are not exposed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'waspada_l4_report_revision_impact_reader'
  ) THEN
    CREATE ROLE waspada_l4_report_revision_impact_reader NOLOGIN NOINHERIT;
  END IF;
END;
$$;

ALTER ROLE waspada_l4_report_revision_impact_reader
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

REVOKE ALL PRIVILEGES ON SCHEMA waspada
  FROM waspada_l4_report_revision_impact_reader;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA waspada
  FROM waspada_l4_report_revision_impact_reader;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA waspada
  FROM waspada_l4_report_revision_impact_reader;

-- The capability is standalone even if a local database already had a role with this name.
DO $$
DECLARE membership record;
BEGIN
  FOR membership IN
    SELECT granted.rolname AS granted_role
    FROM pg_auth_members AS m
    JOIN pg_roles AS granted ON granted.oid = m.roleid
    WHERE m.member = (
      SELECT oid FROM pg_roles WHERE rolname = 'waspada_l4_report_revision_impact_reader'
    )
  LOOP
    EXECUTE format(
      'REVOKE %I FROM waspada_l4_report_revision_impact_reader',
      membership.granted_role
    );
  END LOOP;

  FOR membership IN
    SELECT member_role.rolname AS member_role
    FROM pg_auth_members AS m
    JOIN pg_roles AS member_role ON member_role.oid = m.member
    WHERE m.roleid = (
      SELECT oid FROM pg_roles WHERE rolname = 'waspada_l4_report_revision_impact_reader'
    )
  LOOP
    EXECUTE format(
      'REVOKE waspada_l4_report_revision_impact_reader FROM %I',
      membership.member_role
    );
  END LOOP;
END;
$$;

GRANT USAGE ON SCHEMA waspada TO waspada_l4_report_revision_impact_reader;

GRANT SELECT (dataset_kind, event_id, version, publication_status)
  ON waspada.event_versions TO waspada_l4_report_revision_impact_reader;
GRANT SELECT (dataset_kind, event_id, event_version, claim_id, evidence_kind, evidence_ref_id)
  ON waspada.event_claim_evidence TO waspada_l4_report_revision_impact_reader;
GRANT SELECT (dataset_kind, evidence_ref_id, report_revision_id, relation)
  ON waspada.evidence_references TO waspada_l4_report_revision_impact_reader;
GRANT SELECT (dataset_kind, event_id, event_version, impact_id, impact_version)
  ON waspada.event_impact_refs TO waspada_l4_report_revision_impact_reader;
GRANT SELECT (dataset_kind, impact_id, impact_version, event_id, event_version, claim_id)
  ON waspada.impact_claim_support TO waspada_l4_report_revision_impact_reader;
