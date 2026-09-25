-- Align stored evidence references with the existing schema 2.0 relation enum.
ALTER TABLE waspada.evidence_references
  DROP CONSTRAINT IF EXISTS evidence_references_relation_check;

ALTER TABLE waspada.evidence_references
  ADD CONSTRAINT evidence_references_relation_check
  CHECK (relation IN ('supports', 'contradicts', 'updates', 'context'));
