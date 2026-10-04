-- Retain exact immutable source-observation identity only on private freshness transitions.
ALTER TABLE waspada.freshness_transitions
  ADD COLUMN source_observation_id text;

ALTER TABLE waspada.freshness_transitions
  ADD CONSTRAINT freshness_transitions_source_observation_fk
    FOREIGN KEY (dataset_kind, source_observation_id)
    REFERENCES waspada.report_revision_source_observations (dataset_kind, observation_id);

ALTER TABLE waspada.freshness_transitions
  DROP CONSTRAINT freshness_transitions_reason_check;

DO $$
DECLARE
  reason_status_check text;
BEGIN
  SELECT c.conname INTO reason_status_check
  FROM pg_constraint AS c
  WHERE c.conrelid = 'waspada.freshness_transitions'::regclass
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%previous_status%'
    AND pg_get_constraintdef(c.oid) LIKE '%resulting_status%'
    AND pg_get_constraintdef(c.oid) LIKE '%new_applicable_evidence_evaluated%';
  IF reason_status_check IS NULL THEN
    RAISE EXCEPTION 'freshness transition reason/status constraint was not found';
  END IF;
  EXECUTE format('ALTER TABLE waspada.freshness_transitions DROP CONSTRAINT %I', reason_status_check);
END;
$$;

ALTER TABLE waspada.freshness_transitions
  ADD CONSTRAINT freshness_transitions_reason_check CHECK (reason IN (
    'issuer_validity_ended', 'new_applicable_evidence_evaluated', 'review_deadline_missed',
    'source_report_retracted', 'source_report_superseded'
  )),
  ADD CONSTRAINT freshness_transitions_reason_status_check CHECK (
    (reason = 'issuer_validity_ended' AND resulting_status = 'expired'
      AND previous_status IN ('current', 'needs_update') AND source_observation_id IS NULL)
    OR (reason = 'review_deadline_missed' AND previous_status = 'current'
      AND resulting_status = 'needs_update' AND source_observation_id IS NULL)
    OR (reason = 'new_applicable_evidence_evaluated'
      AND previous_status IN ('needs_update', 'expired') AND resulting_status = 'current'
      AND source_observation_id IS NULL)
    OR (reason IN ('source_report_retracted', 'source_report_superseded')
      AND dataset_kind = 'live' AND previous_status = 'current'
      AND resulting_status = 'needs_update' AND source_observation_id IS NOT NULL)
  );

-- The L4 writer sees this one additional private ledger column only. The FK uses
-- PostgreSQL's internal referential check; it does not grant source-table reads.
GRANT SELECT (source_observation_id)
  ON waspada.freshness_transitions TO waspada_l4_freshness_writer;
GRANT INSERT (source_observation_id)
  ON waspada.freshness_transitions TO waspada_l4_freshness_writer;
