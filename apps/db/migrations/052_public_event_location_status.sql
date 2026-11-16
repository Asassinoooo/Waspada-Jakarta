-- HOSTED-18 (owner decision 17 Nov 2026): a labelled agent event with no place id and no geometry is listed as a
-- whole view. The Event 2.0 record has no label slot, so the publication decision records only whether a label was
-- present (publication_decisions.record_json.location_label_present). This view exposes that one boolean to the public
-- reader, per event version. It exposes no decision, proposal, reviewer or label text. Versions published before this
-- migration carry no flag and read as false, so they stay skipped. The publication role receives no grant here.
CREATE VIEW waspada.public_event_location_status
WITH (security_barrier = true)
AS
SELECT event.dataset_kind,
       event.event_id,
       event.version,
       COALESCE((decision.record_json ->> 'location_label_present') = 'true', false) AS location_label_present
FROM waspada.event_versions AS event
JOIN waspada.publication_decisions AS decision
  ON decision.dataset_kind = event.dataset_kind
 AND decision.decision_id = event.publication_decision_id;

GRANT SELECT ON waspada.public_event_location_status TO waspada_public_reader;
