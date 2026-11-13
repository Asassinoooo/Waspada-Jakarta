-- TG-FR12: a moderator correction is stored as an event proposal that links to the event it corrects
-- (event_id, base_event_version) in the same transaction as its decision. Only the columns that row needs are
-- granted to the L4 publication writer. event_proposals stays append-only: the existing trigger still refuses
-- UPDATE and DELETE.
GRANT INSERT (
  dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id, base_event_version,
  investigation_id, proposed_at, record_json
) ON TABLE waspada.event_proposals
  TO waspada_l4_publication_writer;
