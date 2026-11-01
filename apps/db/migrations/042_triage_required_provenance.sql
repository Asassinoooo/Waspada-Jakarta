-- 042_triage_required_provenance.sql
-- WJ-INT-02B: explicit triage_required provenance on report_revisions.
-- Forward-only; never modifies 001-041.
--
-- Backfill predicate choice: UPDATE ... WHERE source_revision_key IS NOT NULL.
-- Per plan contingency, the conservative predicate is used because production
-- report_revisions cannot be cleanly separated into RSS vs structured rows by
-- source_id inspection alone; every row with a source_revision_key comes from
-- an RSS-origin ingest path (PetaBencana/BMKG pollers use NULL keys with
-- synthetic revision ids, webhook/synthetic fixtures likewise). Rows that keep
-- the default false are structured/webhook/synthetic revisions that must run
-- the job-runner untriaged. No row is left ambiguous: every row ends true or
-- false, never inferred at read time. New inserts must always list the column.

ALTER TABLE waspada.report_revisions
  ADD COLUMN IF NOT EXISTS triage_required boolean NOT NULL DEFAULT false;

UPDATE waspada.report_revisions
  SET triage_required = true
  WHERE source_revision_key IS NOT NULL
    AND triage_required = false;
