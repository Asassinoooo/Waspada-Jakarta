-- Add the separately accepted withdrawn-source reason to the private freshness ledger.
-- The existing source-observation FK and writer column grants continue to bind
-- and keep the exact observation identity private.
ALTER TABLE waspada.freshness_transitions
  DROP CONSTRAINT freshness_transitions_reason_check,
  DROP CONSTRAINT freshness_transitions_reason_status_check;

ALTER TABLE waspada.freshness_transitions
  ADD CONSTRAINT freshness_transitions_reason_check CHECK (reason IN (
    'issuer_validity_ended', 'new_applicable_evidence_evaluated', 'review_deadline_missed',
    'source_report_retracted', 'source_report_superseded', 'source_report_withdrawn'
  )),
  ADD CONSTRAINT freshness_transitions_reason_status_check CHECK (
    (reason = 'issuer_validity_ended' AND resulting_status = 'expired'
      AND previous_status IN ('current', 'needs_update') AND source_observation_id IS NULL)
    OR (reason = 'review_deadline_missed' AND previous_status = 'current'
      AND resulting_status = 'needs_update' AND source_observation_id IS NULL)
    OR (reason = 'new_applicable_evidence_evaluated'
      AND previous_status IN ('needs_update', 'expired') AND resulting_status = 'current'
      AND source_observation_id IS NULL)
    OR (reason IN ('source_report_retracted', 'source_report_superseded', 'source_report_withdrawn')
      AND dataset_kind = 'live' AND previous_status = 'current'
      AND resulting_status = 'needs_update' AND source_observation_id IS NOT NULL)
  );
