-- API-PUBLIC-LOOKUPS-CORE: append-only reviewed lookup snapshots for L4.
-- This schema does not create source-rights decisions or public attribution data.

-- A foreign key across the row identifier and every L4 support-key component
-- makes an attribution decision refer to one exact persisted evidence row.
CREATE UNIQUE INDEX evidence_references_exact_identity_uq
  ON waspada.evidence_references (
    dataset_kind, evidence_ref_id, report_revision_id, permitted_text_hash,
    span_start, span_end, offset_unit, relation
  );

CREATE TABLE waspada.scope_name_review_decisions (
  review_decision_id text PRIMARY KEY
    CHECK (review_decision_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  entity_type text NOT NULL CHECK (entity_type IN ('place', 'service', 'institution', 'audience')),
  entity_id text NOT NULL CHECK (entity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  locale text NOT NULL CHECK (locale ~ '^[a-z]{2}-[A-Z]{2}$'),
  review_version integer NOT NULL CHECK (review_version > 0),
  decision_status text NOT NULL CHECK (decision_status IN ('approved', 'held', 'withdrawn')),
  display_name text,
  provenance_ref text NOT NULL CHECK (length(btrim(provenance_ref)) BETWEEN 1 AND 500),
  reviewer_id text NOT NULL CHECK (reviewer_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  decision_reason text NOT NULL CHECK (length(btrim(decision_reason)) BETWEEN 1 AND 1000),
  reviewed_at timestamptz NOT NULL,
  UNIQUE (entity_type, entity_id, locale, review_version),
  CHECK (
    (decision_status = 'approved'
      AND display_name IS NOT NULL
      AND length(display_name) BETWEEN 1 AND 200
      AND display_name = btrim(display_name))
    OR
    (decision_status <> 'approved' AND display_name IS NULL)
  )
);

CREATE TABLE waspada.public_attribution_review_decisions (
  review_decision_id text PRIMARY KEY
    CHECK (review_decision_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  dataset_kind text NOT NULL CHECK (dataset_kind = 'live'),
  evidence_ref_id bigint NOT NULL,
  report_revision_id text NOT NULL,
  permitted_text_hash text NOT NULL CHECK (permitted_text_hash ~ '^[a-f0-9]{64}$'),
  span_start integer NOT NULL CHECK (span_start >= 0),
  span_end integer NOT NULL CHECK (span_end > span_start),
  offset_unit text NOT NULL CHECK (offset_unit = 'unicode_code_points'),
  relation text NOT NULL CHECK (relation = 'supports'),
  review_version integer NOT NULL CHECK (review_version > 0),
  decision_status text NOT NULL CHECK (decision_status IN ('approved', 'held', 'revoked')),
  rights_basis_ref text NOT NULL CHECK (length(btrim(rights_basis_ref)) BETWEEN 1 AND 500),
  public_display_name text,
  source_url text,
  source_published_at timestamptz,
  source_observed_at timestamptz,
  reviewer_id text NOT NULL CHECK (reviewer_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  decision_reason text NOT NULL CHECK (length(btrim(decision_reason)) BETWEEN 1 AND 1000),
  reviewed_at timestamptz NOT NULL,
  UNIQUE (dataset_kind, evidence_ref_id, review_version),
  FOREIGN KEY (
    dataset_kind, evidence_ref_id, report_revision_id, permitted_text_hash,
    span_start, span_end, offset_unit, relation
  ) REFERENCES waspada.evidence_references (
    dataset_kind, evidence_ref_id, report_revision_id, permitted_text_hash,
    span_start, span_end, offset_unit, relation
  ),
  CHECK (
    (decision_status = 'approved'
      AND public_display_name IS NOT NULL
      AND length(public_display_name) BETWEEN 1 AND 200
      AND public_display_name = btrim(public_display_name)
      AND source_url IS NOT NULL
      AND length(source_url) BETWEEN 9 AND 2048
      AND source_url = btrim(source_url)
      AND source_url ~ '^https://[^[:space:]]+$')
    OR
    (decision_status <> 'approved'
      AND public_display_name IS NULL
      AND source_url IS NULL
      AND source_published_at IS NULL
      AND source_observed_at IS NULL)
  )
);

CREATE TRIGGER scope_name_review_decisions_append_only
  BEFORE UPDATE OR DELETE ON waspada.scope_name_review_decisions
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();
CREATE TRIGGER public_attribution_review_decisions_append_only
  BEFORE UPDATE OR DELETE ON waspada.public_attribution_review_decisions
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();

CREATE FUNCTION waspada.reject_immutable_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER scope_name_review_decisions_no_truncate
  BEFORE TRUNCATE ON waspada.scope_name_review_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION waspada.reject_immutable_truncate();
CREATE TRIGGER public_attribution_review_decisions_no_truncate
  BEFORE TRUNCATE ON waspada.public_attribution_review_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION waspada.reject_immutable_truncate();

CREATE VIEW waspada.public_scope_names WITH (security_barrier = true) AS
WITH latest AS (
  SELECT DISTINCT ON (entity_type, entity_id, locale)
         entity_type, entity_id, locale, review_version, decision_status, display_name
  FROM waspada.scope_name_review_decisions
  ORDER BY entity_type, entity_id, locale, review_version DESC
)
SELECT entity_type, entity_id AS id, display_name
FROM latest
WHERE locale = 'id-ID' AND decision_status = 'approved';

CREATE VIEW waspada.public_source_attributions WITH (security_barrier = true) AS
WITH latest AS (
  SELECT DISTINCT ON (dataset_kind, evidence_ref_id)
         dataset_kind, evidence_ref_id, review_version, decision_status,
         public_display_name, source_url, source_published_at, source_observed_at
  FROM waspada.public_attribution_review_decisions
  ORDER BY dataset_kind, evidence_ref_id, review_version DESC
)
SELECT latest.dataset_kind,
       evidence.report_revision_id,
       evidence.permitted_text_hash,
       evidence.span_start,
       evidence.span_end,
       evidence.offset_unit,
       evidence.relation,
       true AS public_use_approved,
       latest.public_display_name AS display_name,
       latest.source_url AS url,
       CASE WHEN latest.source_published_at IS NULL THEN NULL
         ELSE to_char(latest.source_published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
       END AS published_at,
       CASE WHEN latest.source_observed_at IS NULL THEN NULL
         ELSE to_char(latest.source_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
       END AS observed_at,
       false AS excerpt_public_use_approved,
       NULL::text AS excerpt
FROM latest
JOIN waspada.evidence_references AS evidence
  ON evidence.dataset_kind = latest.dataset_kind
 AND evidence.evidence_ref_id = latest.evidence_ref_id
WHERE latest.decision_status = 'approved';

-- Approval records stay owner-only until MOD-01 provides an authenticated writer.
REVOKE ALL PRIVILEGES ON TABLE
  waspada.scope_name_review_decisions,
  waspada.public_attribution_review_decisions
FROM PUBLIC, waspada_public_reader, waspada_l1_pipeline,
  waspada_l2_grounding_reader, waspada_l2_grounding_writer,
  waspada_l3_coordinator, waspada_l4_publication_writer;

REVOKE ALL PRIVILEGES ON TABLE
  waspada.public_scope_names,
  waspada.public_source_attributions
FROM PUBLIC, waspada_public_reader, waspada_l1_pipeline,
  waspada_l2_grounding_reader, waspada_l2_grounding_writer,
  waspada_l3_coordinator, waspada_l4_publication_writer;

GRANT SELECT ON TABLE
  waspada.public_scope_names,
  waspada.public_source_attributions
TO waspada_public_reader;
