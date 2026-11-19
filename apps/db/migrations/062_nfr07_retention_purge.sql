-- 062_nfr07_retention_purge.sql
-- NFR-07 F-39, F-40 and F-41: the retention purge that ADR-005 requires. Forward-only.
--
-- What changes in 001-061:
--   * report_revisions.permitted_text may be NULL (purged text). No other column of a revision changes.
--   * The append-only triggers on report_revisions, audit_records and account_admin_audit are replaced by guards that
--     allow exactly the retention mutations below and reject everything else with the messages they had before.
--     The shared waspada.reject_immutable_mutation() is not changed, so every other append-only table keeps its guard.
--   * A NOLOGIN role, waspada_retention_purger, runs one function, waspada.purge_expired_retention(now).
--
-- Rules (ADR-005 retention schedule; p_now is the clock of the run):
--   Source text (F-39). permitted_text is set to NULL when either
--     a. retrieved_at <= p_now - 365 days (the hard cap for every revision), or
--     b. no current published event version cites the revision, no open AI job or undecided proposal needs it, and
--        90 days have passed since the revision's text last mattered. That moment is the stop time of the last citing
--        event version. A version stops being current when its successor is published, or when its successor is a
--        withdrawal, at the withdrawal time. A revision that no published version ever cited counts from retrieved_at.
--        A citation whose stop time is unknown keeps the text, and the 365-day cap still applies.
--   Vectors (F-40). The vectors of a revision whose text was nulled, or whose revision was retracted, are deleted in the
--     same call, which meets the ADR's 24-hour bound. Their embedding runs become 'invalidated' and their evidence
--     chunks become 'invalidated'. Vectors of current text are kept, however old they are.
--   Audit (F-41). audit_records and account_admin_audit rows with occurred_at < p_now - 24 months are deleted. No audit
--     row is ever updated. The guard refuses to delete a younger row for any role, because it checks the row's age
--     against the database clock.
--   Triage caches. news_triage_decisions rows that expired more than 30 days before p_now are deleted. The grace
--   period keeps a decision while its item can still appear in a feed, so the item is not triaged again. news_triage_attempts is an
--     append-only ledger with no expiry rule in ADR-005, so it is not purged.
--
-- Nulled, not deleted: report_revisions rows keep their hash, retrieved_at, status and every key that points at them.
-- Deleted: vectors, audit rows older than 24 months, expired triage decisions.
-- Never touched: event_versions, event_claims, evidence references, publication decisions and public attribution reviews.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waspada_retention_purger') THEN
    CREATE ROLE waspada_retention_purger NOLOGIN;
  END IF;
END;
$$;

ALTER ROLE waspada_retention_purger
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

GRANT USAGE ON SCHEMA waspada TO waspada_retention_purger;

-- A purged revision keeps its row, hash and retrieved_at. Its text is empty, so the column may be NULL.
-- The existing CHECK (length BETWEEN 1 AND 2000000) already accepts NULL.
ALTER TABLE waspada.report_revisions ALTER COLUMN permitted_text DROP NOT NULL;

-- Guard for report_revisions: the only permitted change is permitted_text from a value to NULL.
CREATE OR REPLACE FUNCTION waspada.guard_report_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, waspada
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.permitted_text IS NOT NULL
     AND NEW.permitted_text IS NULL
     AND to_jsonb(NEW) - 'permitted_text' = to_jsonb(OLD) - 'permitted_text' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

-- Guard for audit_records: no update, and a delete only of a row older than 24 months on the database clock.
CREATE OR REPLACE FUNCTION waspada.guard_audit_record_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, waspada
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.occurred_at < now() - interval '24 months' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '%.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

-- Guard for account_admin_audit: the same rule as audit_records, with the account audit message.
CREATE OR REPLACE FUNCTION waspada.guard_account_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, waspada
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.occurred_at < now() - interval '24 months' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'account audit rows are append-only';
END;
$$;

DROP TRIGGER IF EXISTS report_revisions_append_only ON waspada.report_revisions;
CREATE TRIGGER report_revisions_append_only
  BEFORE UPDATE OR DELETE ON waspada.report_revisions
  FOR EACH ROW EXECUTE FUNCTION waspada.guard_report_revision_mutation();

DROP TRIGGER IF EXISTS audit_records_append_only ON waspada.audit_records;
CREATE TRIGGER audit_records_append_only
  BEFORE UPDATE OR DELETE ON waspada.audit_records
  FOR EACH ROW EXECUTE FUNCTION waspada.guard_audit_record_mutation();

DROP TRIGGER IF EXISTS account_admin_audit_append_only ON waspada.account_admin_audit;
CREATE TRIGGER account_admin_audit_append_only
  BEFORE UPDATE OR DELETE ON waspada.account_admin_audit
  FOR EACH ROW EXECUTE FUNCTION waspada.guard_account_audit_mutation();

GRANT SELECT ON waspada.report_revisions,
                waspada.evidence_references,
                waspada.evidence_chunks,
                waspada.embedding_runs,
                waspada.embedding_vectors,
                waspada.event_versions,
                waspada.event_claim_evidence,
                waspada.proposal_claim_evidence,
                waspada.publication_decisions,
                waspada.ai_jobs,
                waspada.audit_records,
                waspada.account_admin_audit,
                waspada.news_triage_decisions
  TO waspada_retention_purger;

GRANT UPDATE (permitted_text) ON waspada.report_revisions TO waspada_retention_purger;
GRANT UPDATE (status) ON waspada.embedding_runs TO waspada_retention_purger;
GRANT UPDATE (status) ON waspada.evidence_chunks TO waspada_retention_purger;
GRANT DELETE ON waspada.embedding_vectors,
                waspada.audit_records,
                waspada.account_admin_audit,
                waspada.news_triage_decisions
  TO waspada_retention_purger;

CREATE OR REPLACE FUNCTION waspada.purge_expired_retention(p_now timestamptz)
RETURNS TABLE (
  source_text_nulled bigint,
  vectors_removed bigint,
  audit_records_removed bigint,
  account_admin_audit_removed bigint,
  triage_decisions_removed bigint
)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, waspada
AS $$
DECLARE
  v_text bigint := 0;
  v_vectors bigint := 0;
  v_audit bigint := 0;
  v_admin_audit bigint := 0;
  v_triage bigint := 0;
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'retention_now_required' USING ERRCODE = '22004';
  END IF;

  -- 1. Source text (F-39).
  WITH citing AS (
    -- Each published event version that cites a revision. The version chain is strict (version N+1 supersedes N), so
    -- a version has no successor exactly when it is the current one.
    SELECT er.dataset_kind,
           er.report_revision_id,
           nxt.version IS NULL AS is_current,
           coalesce(nxt.published_at, nxt.withdrawn_at) AS stopped_at
      FROM waspada.event_claim_evidence AS ece
      JOIN waspada.evidence_references AS er
        ON er.dataset_kind = ece.dataset_kind
       AND er.evidence_ref_id = ece.evidence_ref_id
      JOIN waspada.event_versions AS ev
        ON ev.dataset_kind = ece.dataset_kind
       AND ev.event_id = ece.event_id
       AND ev.version = ece.event_version
      LEFT JOIN waspada.event_versions AS nxt
        ON nxt.dataset_kind = ev.dataset_kind
       AND nxt.event_id = ev.event_id
       AND nxt.version = ev.version + 1
     WHERE ev.publication_status = 'published'
  ),
  citation AS (
    SELECT dataset_kind,
           report_revision_id,
           bool_or(is_current) AS held_by_current,
           bool_or(NOT is_current AND stopped_at IS NULL) AS stop_unknown,
           max(stopped_at) FILTER (WHERE NOT is_current) AS last_stopped_at
      FROM citing
     GROUP BY dataset_kind, report_revision_id
  ),
  open_work AS (
    SELECT j.dataset_kind, j.report_revision_id
      FROM waspada.ai_jobs AS j
     WHERE j.status IN ('pending', 'leased', 'retry', 'needs_review')
    UNION
    SELECT er.dataset_kind, er.report_revision_id
      FROM waspada.proposal_claim_evidence AS pce
      JOIN waspada.evidence_references AS er
        ON er.dataset_kind = pce.dataset_kind
       AND er.evidence_ref_id = pce.evidence_ref_id
     WHERE NOT EXISTS (
       SELECT 1
         FROM waspada.publication_decisions AS pd
        WHERE pd.dataset_kind = pce.dataset_kind
          AND pd.proposal_id = pce.proposal_id
     )
  )
  UPDATE waspada.report_revisions AS rr
     SET permitted_text = NULL
   WHERE rr.permitted_text IS NOT NULL
     AND (
       rr.retrieved_at <= p_now - interval '365 days'
       OR (
         NOT EXISTS (
           SELECT 1 FROM citation AS c
            WHERE c.dataset_kind = rr.dataset_kind
              AND c.report_revision_id = rr.report_revision_id
              AND (c.held_by_current OR c.stop_unknown)
         )
         AND NOT EXISTS (
           SELECT 1 FROM open_work AS o
            WHERE o.dataset_kind = rr.dataset_kind
              AND o.report_revision_id = rr.report_revision_id
         )
         AND greatest(
           rr.retrieved_at,
           coalesce((
             SELECT c.last_stopped_at FROM citation AS c
              WHERE c.dataset_kind = rr.dataset_kind
                AND c.report_revision_id = rr.report_revision_id
           ), rr.retrieved_at)
         ) <= p_now - interval '90 days'
       )
     );
  GET DIAGNOSTICS v_text = ROW_COUNT;

  -- 2. Vectors and evidence chunks (F-40). The runs are marked before the vectors that name them are deleted.
  UPDATE waspada.embedding_runs AS r
     SET status = 'invalidated'
    FROM waspada.embedding_vectors AS v,
         waspada.evidence_chunks AS c,
         waspada.report_revisions AS rr
   WHERE v.dataset_kind = r.dataset_kind
     AND v.embedding_run_id = r.embedding_run_id
     AND c.dataset_kind = r.dataset_kind
     AND c.chunk_id = r.chunk_id
     AND rr.dataset_kind = c.dataset_kind
     AND rr.report_revision_id = c.report_revision_id
     AND (rr.permitted_text IS NULL OR rr.revision_status = 'retracted')
     AND r.status <> 'invalidated';

  DELETE FROM waspada.embedding_vectors AS v
   USING waspada.embedding_runs AS r,
         waspada.evidence_chunks AS c,
         waspada.report_revisions AS rr
   WHERE r.dataset_kind = v.dataset_kind
     AND r.embedding_run_id = v.embedding_run_id
     AND c.dataset_kind = r.dataset_kind
     AND c.chunk_id = r.chunk_id
     AND rr.dataset_kind = c.dataset_kind
     AND rr.report_revision_id = c.report_revision_id
     AND (rr.permitted_text IS NULL OR rr.revision_status = 'retracted');
  GET DIAGNOSTICS v_vectors = ROW_COUNT;

  UPDATE waspada.evidence_chunks AS c
     SET status = 'invalidated'
    FROM waspada.report_revisions AS rr
   WHERE rr.dataset_kind = c.dataset_kind
     AND rr.report_revision_id = c.report_revision_id
     AND (rr.permitted_text IS NULL OR rr.revision_status = 'retracted')
     AND c.status <> 'invalidated';

  -- 3. Audit (F-41): only rows older than 24 months.
  DELETE FROM waspada.audit_records AS a
   WHERE a.occurred_at < p_now - interval '24 months';
  GET DIAGNOSTICS v_audit = ROW_COUNT;

  DELETE FROM waspada.account_admin_audit AS a
   WHERE a.occurred_at < p_now - interval '24 months';
  GET DIAGNOSTICS v_admin_audit = ROW_COUNT;

  -- 4. Triage caches whose expiry has passed.
  DELETE FROM waspada.news_triage_decisions AS d
   WHERE d.expires_at < p_now - interval '30 days';
  GET DIAGNOSTICS v_triage = ROW_COUNT;

  RETURN QUERY SELECT v_text, v_vectors, v_audit, v_admin_audit, v_triage;
END;
$$;

REVOKE ALL ON FUNCTION waspada.purge_expired_retention(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION waspada.purge_expired_retention(timestamptz) TO waspada_retention_purger;
