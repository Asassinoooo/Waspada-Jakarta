-- HOSTED-02: a published proposal writes one approved review row, which the public history and updates views read.
-- The publication writer had no privilege on the review table. Only the columns the writer sets are granted.
-- review_id comes from the identity default, which needs no sequence grant (verified: the insert reaches the
-- foreign key check without a sequence privilege error). change_sequence comes from the existing BEFORE INSERT
-- trigger, and the table stays append-only (UPDATE, DELETE and TRUNCATE are still refused).
GRANT INSERT (
  dataset_kind, event_id, event_version, review_status, change_type, summary, reviewer_id, reviewed_at
) ON TABLE waspada.public_event_history_review_decisions
  TO waspada_l4_publication_writer;

-- HOSTED-02: publication_mode is no longer stored in event_versions.record_json (the public readers require the exact
-- domain key set). The flow view reads it from the decision that published the version. Columns are unchanged.
CREATE OR REPLACE VIEW waspada.pipeline_flow_versions WITH (security_barrier = true) AS
  SELECT ev.dataset_kind,
         ev.event_id,
         ev.version,
         ev.title,
         ev.publication_status,
         ev.published_at,
         decision.record_json ->> 'publication_mode' AS publication_mode
    FROM waspada.event_versions ev
    LEFT JOIN waspada.publication_decisions decision
      ON decision.dataset_kind = ev.dataset_kind
     AND decision.decision_id = ev.publication_decision_id;
