DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM waspada.evidence_references
    GROUP BY dataset_kind, report_revision_id, permitted_text_hash,
             span_start, span_end, offset_unit, relation
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      '007_l1_write_idempotency refuses pre-existing duplicate natural evidence-reference identities';
  END IF;
END;
$$;

CREATE UNIQUE INDEX evidence_references_natural_identity_uq
  ON waspada.evidence_references (
    dataset_kind, report_revision_id, permitted_text_hash,
    span_start, span_end, offset_unit, relation
  );
