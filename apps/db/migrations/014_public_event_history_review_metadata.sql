-- API-PUBLIC-HISTORY-REVIEW-METADATA-CORE: retain append-only moderator
-- disclosure decisions for exact published live event versions. MOD-01 owns
-- authenticated writes; no write privilege is granted here.

CREATE TABLE waspada.public_event_history_review_decisions (
  review_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dataset_kind text NOT NULL CHECK (dataset_kind = 'live'),
  event_id text NOT NULL CHECK (event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  event_version integer NOT NULL CHECK (event_version > 0),
  publication_status text NOT NULL DEFAULT 'published' CHECK (publication_status = 'published'),
  review_status text NOT NULL CHECK (review_status IN ('approved', 'held', 'revoked')),
  change_type text,
  summary text,
  reviewer_id text NOT NULL CHECK (reviewer_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  reviewed_at timestamptz NOT NULL CHECK (isfinite(reviewed_at)),
  FOREIGN KEY (dataset_kind, event_id, event_version, publication_status)
    REFERENCES waspada.event_versions (dataset_kind, event_id, version, publication_status),
  CHECK (
    (review_status = 'approved'
      AND change_type IS NOT NULL
      AND change_type IN ('published', 'corrected', 'impact_changed', 'retracted')
      AND summary IS NOT NULL
      AND char_length(summary) BETWEEN 1 AND 500
      AND summary ~ '[^[:space:]]')
    OR
    (review_status IN ('held', 'revoked')
      AND change_type IS NULL
      AND summary IS NULL)
  )
);

CREATE INDEX public_event_history_review_latest_idx
  ON waspada.public_event_history_review_decisions
    (dataset_kind, event_id, event_version, review_id DESC);

CREATE TRIGGER public_event_history_review_decisions_append_only
  BEFORE UPDATE OR DELETE ON waspada.public_event_history_review_decisions
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();

CREATE TRIGGER public_event_history_review_decisions_no_truncate
  BEFORE TRUNCATE ON waspada.public_event_history_review_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION waspada.reject_immutable_truncate();

-- Choose the latest decision before filtering to approved. A later held or
-- revoked row therefore suppresses any older approval. Joining the existing
-- history view applies its current-public, live, published, exact-version and
-- latest-withdrawal rules without exposing event record_json here.
CREATE VIEW waspada.public_event_history_review_metadata
WITH (security_barrier = true)
AS
WITH latest_review AS (
  SELECT DISTINCT ON (decision.dataset_kind, decision.event_id, decision.event_version)
         decision.dataset_kind, decision.event_id, decision.event_version,
         decision.review_status, decision.change_type, decision.summary,
         decision.reviewer_id, decision.reviewed_at
  FROM waspada.public_event_history_review_decisions AS decision
  ORDER BY decision.dataset_kind, decision.event_id, decision.event_version,
           decision.review_id DESC
)
SELECT latest.dataset_kind, latest.event_id, latest.event_version,
       latest.review_status, latest.change_type, latest.summary,
       latest.reviewer_id, latest.reviewed_at
FROM latest_review AS latest
JOIN waspada.public_event_history_versions AS history
  ON history.dataset_kind = latest.dataset_kind
 AND history.event_id = latest.event_id
 AND history.version = latest.event_version
WHERE latest.review_status = 'approved';

-- Review snapshots remain private to the owner until MOD-01 supplies an
-- authenticated writer. The public reader can see only the filtered approved
-- view, and has no direct table or sequence access.
REVOKE ALL PRIVILEGES ON TABLE waspada.public_event_history_review_decisions
FROM PUBLIC, waspada_public_reader, waspada_l1_pipeline,
  waspada_l2_grounding_reader, waspada_l2_grounding_writer,
  waspada_l3_coordinator, waspada_l4_publication_writer;

REVOKE ALL PRIVILEGES ON SEQUENCE
  waspada.public_event_history_review_decisions_review_id_seq
FROM PUBLIC, waspada_public_reader, waspada_l1_pipeline,
  waspada_l2_grounding_reader, waspada_l2_grounding_writer,
  waspada_l3_coordinator, waspada_l4_publication_writer;

REVOKE ALL PRIVILEGES ON TABLE waspada.public_event_history_review_metadata
FROM PUBLIC, waspada_public_reader, waspada_l1_pipeline,
  waspada_l2_grounding_reader, waspada_l2_grounding_writer,
  waspada_l3_coordinator, waspada_l4_publication_writer;

GRANT SELECT ON TABLE waspada.public_event_history_review_metadata
TO waspada_public_reader;
