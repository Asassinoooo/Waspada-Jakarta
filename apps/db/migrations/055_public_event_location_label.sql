-- HOSTED-26 (owner decision, 18 Nov 2026): the public reader may now see the sanitized location label of a published
-- event version, as text. This reverses migration 052's "no label text" rule for that one field. The label is the text the
-- publication decision recorded (publicLocationLabel: trimmed, whitespace collapsed, at most 200 characters, and never a
-- generic label such as "DKI Jakarta"). The view returns it only when the decision carries it, so an older version reads
-- NULL. It exposes no decision, proposal, reviewer or any other label. The existing columns keep their names, types and
-- order, and location_label is added at the end. The view stays a security barrier.
CREATE OR REPLACE VIEW waspada.public_event_location_status
WITH (security_barrier = true)
AS
SELECT event.dataset_kind,
       event.event_id,
       event.version,
       COALESCE((decision.record_json ->> 'location_label_present') = 'true', false) AS location_label_present,
       CASE WHEN jsonb_typeof(decision.record_json -> 'location_label') = 'string'
            THEN decision.record_json ->> 'location_label'
       END AS location_label
FROM waspada.event_versions AS event
JOIN waspada.publication_decisions AS decision
  ON decision.dataset_kind = event.dataset_kind
 AND decision.decision_id = event.publication_decision_id;

GRANT SELECT ON waspada.public_event_location_status TO waspada_public_reader;
