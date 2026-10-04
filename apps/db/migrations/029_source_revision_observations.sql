-- Persist explicit publisher assertions separately from immutable source revisions.
CREATE TABLE waspada.report_revision_source_observations (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  observation_id text NOT NULL
    CHECK (observation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  trace_id text NOT NULL,
  source_id text NOT NULL,
  target_report_revision_id text NOT NULL,
  assertion_report_revision_id text NOT NULL,
  asserted_state text NOT NULL
    CHECK (asserted_state IN ('current', 'superseded', 'retracted', 'withdrawn')),
  replacement_report_revision_id text,
  publisher_observed_at timestamptz,
  retrieved_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (dataset_kind, observation_id),
  FOREIGN KEY (trace_id, dataset_kind)
    REFERENCES waspada.traces (trace_id, dataset_kind),
  FOREIGN KEY (dataset_kind, target_report_revision_id, source_id)
    REFERENCES waspada.report_revisions (dataset_kind, report_revision_id, source_id),
  FOREIGN KEY (dataset_kind, assertion_report_revision_id, source_id)
    REFERENCES waspada.report_revisions (dataset_kind, report_revision_id, source_id),
  FOREIGN KEY (dataset_kind, replacement_report_revision_id, source_id)
    REFERENCES waspada.report_revisions (dataset_kind, report_revision_id, source_id),
  CONSTRAINT report_revision_source_observations_replacement_shape CHECK (
    (asserted_state = 'superseded'
      AND replacement_report_revision_id IS NOT NULL
      AND replacement_report_revision_id <> target_report_revision_id)
    OR (asserted_state <> 'superseded' AND replacement_report_revision_id IS NULL)
  )
);

CREATE FUNCTION waspada.validate_report_revision_source_observation_replacement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, waspada
AS $$
BEGIN
  IF NEW.asserted_state = 'superseded'
     AND NOT EXISTS (
       SELECT 1
       FROM waspada.report_revisions AS replacement
       WHERE replacement.dataset_kind = NEW.dataset_kind
         AND replacement.report_revision_id = NEW.replacement_report_revision_id
         AND replacement.source_id = NEW.source_id
         AND replacement.supersedes_id = NEW.target_report_revision_id
     ) THEN
    RAISE EXCEPTION 'report_revision_source_observation_replacement_mismatch'
      USING ERRCODE = '23514',
            CONSTRAINT = 'report_revision_source_observations_replacement_matches_target';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER report_revision_source_observations_validate_replacement
  BEFORE INSERT ON waspada.report_revision_source_observations
  FOR EACH ROW EXECUTE FUNCTION waspada.validate_report_revision_source_observation_replacement();

REVOKE ALL PRIVILEGES ON FUNCTION waspada.validate_report_revision_source_observation_replacement()
  FROM PUBLIC;

CREATE TRIGGER report_revision_source_observations_append_only
  BEFORE UPDATE OR DELETE ON waspada.report_revision_source_observations
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_immutable_mutation();

CREATE TRIGGER report_revision_source_observations_no_truncate
  BEFORE TRUNCATE ON waspada.report_revision_source_observations
  FOR EACH STATEMENT EXECUTE FUNCTION waspada.reject_immutable_truncate();

REVOKE ALL PRIVILEGES ON TABLE waspada.report_revision_source_observations FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE waspada.report_revision_source_observations FROM waspada_l1_pipeline;

GRANT SELECT (
  dataset_kind, observation_id, trace_id, source_id, target_report_revision_id,
  assertion_report_revision_id, asserted_state, replacement_report_revision_id,
  publisher_observed_at, retrieved_at, recorded_at
) ON TABLE waspada.report_revision_source_observations TO waspada_l1_pipeline;

GRANT INSERT (
  dataset_kind, observation_id, trace_id, source_id, target_report_revision_id,
  assertion_report_revision_id, asserted_state, replacement_report_revision_id,
  publisher_observed_at, retrieved_at
) ON TABLE waspada.report_revision_source_observations TO waspada_l1_pipeline;
