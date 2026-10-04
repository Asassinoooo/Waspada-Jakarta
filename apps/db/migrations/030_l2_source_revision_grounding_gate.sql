-- Let the exact-span L2 reader check only explicit publisher assertions for
-- the exact dataset and report revision it is about to rehydrate.
GRANT SELECT (dataset_kind, target_report_revision_id, asserted_state)
  ON TABLE waspada.report_revision_source_observations
  TO waspada_l2_grounding_reader;
