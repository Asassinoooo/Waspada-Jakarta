-- Private one-page keyset state for future live source-revision freshness runs.
-- Cursor data stays outside trace metadata and is reachable only through the
-- fixed-purpose functions below.
CREATE TABLE waspada.source_revision_freshness_cursor_checkpoint (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  cursor jsonb CHECK (cursor IS NULL OR pg_catalog.jsonb_typeof(cursor) = 'object')
);

INSERT INTO waspada.source_revision_freshness_cursor_checkpoint (singleton, cursor)
VALUES (true, NULL);

CREATE TABLE waspada.source_revision_freshness_run_inputs (
  trace_id text PRIMARY KEY REFERENCES waspada.traces (trace_id),
  started_at timestamptz NOT NULL,
  input_cursor jsonb CHECK (input_cursor IS NULL OR pg_catalog.jsonb_typeof(input_cursor) = 'object')
);

-- One immutable page result per run. SQL NULL in output_cursor means the completed
-- page reached the end of a sweep and reset the shared cursor to its initial state.
CREATE TABLE waspada.source_revision_freshness_run_advances (
  trace_id text PRIMARY KEY REFERENCES waspada.source_revision_freshness_run_inputs (trace_id),
  output_cursor jsonb CHECK (output_cursor IS NULL OR pg_catalog.jsonb_typeof(output_cursor) = 'object')
);

CREATE OR REPLACE FUNCTION waspada.source_revision_freshness_cursor_is_valid(p_cursor jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
DECLARE
  v_target jsonb;
  v_event_version_text text;
  v_impact_version_text text;
BEGIN
  IF p_cursor IS NULL OR pg_catalog.jsonb_typeof(p_cursor) IS DISTINCT FROM 'object'
     OR (p_cursor - ARRAY['observationId', 'eventId', 'eventVersion', 'target']) <> '{}'::jsonb
     OR NOT (p_cursor ?& ARRAY['observationId', 'eventId', 'eventVersion', 'target']) THEN
    RETURN false;
  END IF;

  IF pg_catalog.char_length(p_cursor ->> 'observationId') NOT BETWEEN 1 AND 128
     OR (p_cursor ->> 'observationId') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR pg_catalog.char_length(p_cursor ->> 'eventId') NOT BETWEEN 1 AND 128
     OR (p_cursor ->> 'eventId') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR pg_catalog.jsonb_typeof(p_cursor -> 'eventVersion') IS DISTINCT FROM 'number' THEN
    RETURN false;
  END IF;

  v_event_version_text := p_cursor ->> 'eventVersion';
  IF v_event_version_text !~ '^[1-9][0-9]{0,9}$'
     OR v_event_version_text::bigint > 2147483647 THEN
    RETURN false;
  END IF;

  v_target := p_cursor -> 'target';
  IF pg_catalog.jsonb_typeof(v_target) IS DISTINCT FROM 'object'
     OR NOT (v_target ? 'kind') THEN
    RETURN false;
  END IF;

  IF v_target ->> 'kind' = 'event_claim_set' THEN
    RETURN (v_target - ARRAY['kind']) = '{}'::jsonb
       AND (v_target ?& ARRAY['kind']);
  END IF;

  IF v_target ->> 'kind' IS DISTINCT FROM 'impact'
     OR (v_target - ARRAY['kind', 'impactId', 'impactVersion']) <> '{}'::jsonb
     OR NOT (v_target ?& ARRAY['kind', 'impactId', 'impactVersion'])
     OR pg_catalog.char_length(v_target ->> 'impactId') NOT BETWEEN 1 AND 128
     OR (v_target ->> 'impactId') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR pg_catalog.jsonb_typeof(v_target -> 'impactVersion') IS DISTINCT FROM 'number' THEN
    RETURN false;
  END IF;

  v_impact_version_text := v_target ->> 'impactVersion';
  IF v_impact_version_text !~ '^[1-9][0-9]{0,9}$'
     OR v_impact_version_text::bigint > 2147483647 THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION waspada.source_revision_freshness_summary_is_valid(
  p_summary jsonb,
  p_outcome text
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
DECLARE
  v_key text;
  v_value_text text;
  v_counts jsonb := '{}'::jsonb;
  v_candidates integer;
  v_invalidating integer;
  v_selected integer;
  v_duplicates integer;
  v_skipped integer;
  v_processed integer;
BEGIN
  IF pg_catalog.jsonb_typeof(p_summary) IS DISTINCT FROM 'object'
     OR (p_summary - ARRAY[
       'candidates', 'invalidatingCandidates', 'selectedTargets', 'duplicateCandidates',
       'skippedCandidates', 'written', 'replayed', 'noChange'
     ]) <> '{}'::jsonb
     OR NOT (p_summary ?& ARRAY[
       'candidates', 'invalidatingCandidates', 'selectedTargets', 'duplicateCandidates',
       'skippedCandidates', 'written', 'replayed', 'noChange'
     ]) THEN
    RETURN false;
  END IF;

  FOREACH v_key IN ARRAY ARRAY[
    'candidates', 'invalidatingCandidates', 'selectedTargets', 'duplicateCandidates',
    'skippedCandidates', 'written', 'replayed', 'noChange'
  ] LOOP
    IF pg_catalog.jsonb_typeof(p_summary -> v_key) IS DISTINCT FROM 'number' THEN
      RETURN false;
    END IF;
    v_value_text := p_summary ->> v_key;
    IF v_value_text !~ '^(0|[1-9][0-9]?|100)$' THEN
      RETURN false;
    END IF;
    v_counts := v_counts || pg_catalog.jsonb_build_object(v_key, v_value_text::integer);
  END LOOP;

  v_candidates := (v_counts ->> 'candidates')::integer;
  v_invalidating := (v_counts ->> 'invalidatingCandidates')::integer;
  v_selected := (v_counts ->> 'selectedTargets')::integer;
  v_duplicates := (v_counts ->> 'duplicateCandidates')::integer;
  v_skipped := (v_counts ->> 'skippedCandidates')::integer;
  v_processed := (v_counts ->> 'written')::integer
               + (v_counts ->> 'replayed')::integer
               + (v_counts ->> 'noChange')::integer;

  IF v_candidates <> v_invalidating + v_skipped
     OR v_invalidating <> v_selected + v_duplicates
     OR v_processed > v_selected THEN
    RETURN false;
  END IF;
  IF p_outcome = 'succeeded' THEN
    RETURN v_processed = v_selected;
  END IF;
  RETURN p_outcome = 'failed';
END;
$function$;

CREATE OR REPLACE FUNCTION waspada.begin_source_revision_freshness_run(
  p_trace_id text,
  p_started_at text
)
RETURNS TABLE(run_status text, input_cursor jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_started_at timestamptz;
  v_trace waspada.traces%ROWTYPE;
  v_saved_started_at timestamptz;
  v_saved_cursor jsonb;
  v_checkpoint_cursor jsonb;
  v_has_run boolean := false;
  v_has_trace boolean;
  v_has_advance boolean;
  v_inserted integer;
  v_expected_open_metadata jsonb := pg_catalog.jsonb_build_object(
    'trigger', 'source_revision_freshness_transition'
  );
BEGIN
  IF p_trace_id IS NULL
     OR pg_catalog.char_length(p_trace_id) NOT BETWEEN 1 AND 128
     OR p_trace_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR p_started_at IS NULL
     OR pg_catalog.char_length(p_started_at) > 64
     OR pg_catalog.left(p_started_at, 4) = '0000'
     OR p_started_at !~ '^([0-9]{4})-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' THEN
    RAISE EXCEPTION 'invalid source-revision freshness run input'
      USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_started_at := p_started_at::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid source-revision freshness run input'
      USING ERRCODE = '22023';
  END;
  IF NOT pg_catalog.isfinite(v_started_at) THEN
    RAISE EXCEPTION 'invalid source-revision freshness run input'
      USING ERRCODE = '22023';
  END IF;

  SELECT run.started_at, run.input_cursor
    INTO v_saved_started_at, v_saved_cursor
  FROM waspada.source_revision_freshness_run_inputs AS run
  WHERE run.trace_id = p_trace_id
  FOR UPDATE;
  v_has_run := FOUND;

  IF NOT v_has_run THEN
    SELECT checkpoint.cursor
      INTO v_checkpoint_cursor
    FROM waspada.source_revision_freshness_cursor_checkpoint AS checkpoint
    WHERE checkpoint.singleton = true
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'source-revision freshness checkpoint is unavailable'
        USING ERRCODE = '55000';
    END IF;
    IF v_checkpoint_cursor IS NOT NULL
       AND NOT waspada.source_revision_freshness_cursor_is_valid(v_checkpoint_cursor) THEN
      RAISE EXCEPTION 'source-revision freshness checkpoint is invalid'
        USING ERRCODE = '55000';
    END IF;

    -- All new begins serialize on the singleton, then recheck for an exact run
    -- inserted by a concurrent retry using the same stable trace identity.
    SELECT run.started_at, run.input_cursor
      INTO v_saved_started_at, v_saved_cursor
    FROM waspada.source_revision_freshness_run_inputs AS run
    WHERE run.trace_id = p_trace_id
    FOR UPDATE;
    v_has_run := FOUND;
  END IF;

  IF NOT v_has_run THEN
    INSERT INTO waspada.traces
      (trace_id, dataset_kind, started_at, ended_at, outcome, metadata)
    VALUES
      (p_trace_id, 'live', v_started_at, NULL, 'open', v_expected_open_metadata)
    ON CONFLICT (trace_id) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted <> 1 THEN
      RAISE EXCEPTION 'source-revision freshness trace identity conflict'
        USING ERRCODE = '23505';
    END IF;

    SELECT trace.*
      INTO v_trace
    FROM waspada.traces AS trace
    WHERE trace.trace_id = p_trace_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_trace.dataset_kind IS DISTINCT FROM 'live'
       OR v_trace.started_at IS DISTINCT FROM v_started_at
       OR v_trace.ended_at IS NOT NULL
       OR v_trace.outcome IS DISTINCT FROM 'open'
       OR v_trace.metadata IS DISTINCT FROM v_expected_open_metadata THEN
      RAISE EXCEPTION 'source-revision freshness trace identity conflict'
        USING ERRCODE = '23505';
    END IF;

    INSERT INTO waspada.source_revision_freshness_run_inputs
      (trace_id, started_at, input_cursor)
    VALUES (p_trace_id, v_started_at, v_checkpoint_cursor);
    RETURN QUERY SELECT 'open'::text, v_checkpoint_cursor;
    RETURN;
  END IF;

  SELECT trace.*
    INTO v_trace
  FROM waspada.traces AS trace
  WHERE trace.trace_id = p_trace_id
  FOR UPDATE;
  v_has_trace := FOUND;
  SELECT EXISTS (
    SELECT 1
    FROM waspada.source_revision_freshness_run_advances AS advance
    WHERE advance.trace_id = p_trace_id
  ) INTO v_has_advance;

  IF NOT v_has_trace
     OR v_saved_started_at IS DISTINCT FROM v_started_at
     OR v_trace.dataset_kind IS DISTINCT FROM 'live'
     OR v_trace.started_at IS DISTINCT FROM v_started_at THEN
    RAISE EXCEPTION 'source-revision freshness trace identity conflict'
      USING ERRCODE = '23505';
  END IF;

  IF v_trace.outcome = 'open' THEN
    IF v_trace.ended_at IS NOT NULL
       OR v_trace.metadata IS DISTINCT FROM v_expected_open_metadata THEN
      RAISE EXCEPTION 'source-revision freshness trace identity conflict'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT 'open'::text, v_saved_cursor;
    RETURN;
  END IF;

  IF v_trace.outcome IN ('succeeded', 'failed') THEN
    IF v_trace.ended_at IS NULL
       OR NOT pg_catalog.isfinite(v_trace.ended_at)
       OR v_trace.ended_at < v_trace.started_at
       OR v_trace.metadata ->> 'trigger' IS DISTINCT FROM 'source_revision_freshness_transition'
       OR (v_trace.metadata - ARRAY['trigger', 'summary']) <> '{}'::jsonb
       OR NOT waspada.source_revision_freshness_summary_is_valid(
         v_trace.metadata -> 'summary', v_trace.outcome
       )
       OR ((v_trace.outcome = 'succeeded') IS DISTINCT FROM v_has_advance) THEN
      RAISE EXCEPTION 'source-revision freshness trace identity conflict'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_trace.outcome, v_saved_cursor;
    RETURN;
  END IF;

  RAISE EXCEPTION 'source-revision freshness trace identity conflict'
    USING ERRCODE = '23505';
END;
$function$;

CREATE OR REPLACE FUNCTION waspada.advance_source_revision_freshness_run(
  p_trace_id text,
  p_started_at text,
  p_input_cursor jsonb,
  p_next_cursor jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_started_at timestamptz;
  v_saved_started_at timestamptz;
  v_saved_cursor jsonb;
  v_saved_output_cursor jsonb;
  v_trace waspada.traces%ROWTYPE;
  v_checkpoint_cursor jsonb;
  v_has_advance boolean;
  v_updated integer;
  v_expected_open_metadata jsonb := pg_catalog.jsonb_build_object(
    'trigger', 'source_revision_freshness_transition'
  );
BEGIN
  IF p_trace_id IS NULL
     OR pg_catalog.char_length(p_trace_id) NOT BETWEEN 1 AND 128
     OR p_trace_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR p_started_at IS NULL
     OR pg_catalog.char_length(p_started_at) > 64
     OR pg_catalog.left(p_started_at, 4) = '0000'
     OR p_started_at !~ '^([0-9]{4})-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'
     OR (p_input_cursor IS NOT NULL
       AND NOT waspada.source_revision_freshness_cursor_is_valid(p_input_cursor))
     OR (p_next_cursor IS NOT NULL
       AND NOT waspada.source_revision_freshness_cursor_is_valid(p_next_cursor)) THEN
    RAISE EXCEPTION 'invalid source-revision freshness advance input'
      USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_started_at := p_started_at::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid source-revision freshness advance input'
      USING ERRCODE = '22023';
  END;
  IF NOT pg_catalog.isfinite(v_started_at) THEN
    RAISE EXCEPTION 'invalid source-revision freshness advance input'
      USING ERRCODE = '22023';
  END IF;

  IF p_input_cursor IS NOT NULL AND p_next_cursor IS NOT NULL
     AND ROW(
       (p_next_cursor ->> 'observationId') COLLATE "C",
       (p_next_cursor ->> 'eventId') COLLATE "C",
       (p_next_cursor ->> 'eventVersion')::integer,
       (p_next_cursor -> 'target' ->> 'kind') COLLATE "C",
       COALESCE(p_next_cursor -> 'target' ->> 'impactId', '') COLLATE "C",
       COALESCE((p_next_cursor -> 'target' ->> 'impactVersion')::integer, 0)
     ) <= ROW(
       (p_input_cursor ->> 'observationId') COLLATE "C",
       (p_input_cursor ->> 'eventId') COLLATE "C",
       (p_input_cursor ->> 'eventVersion')::integer,
       (p_input_cursor -> 'target' ->> 'kind') COLLATE "C",
       COALESCE(p_input_cursor -> 'target' ->> 'impactId', '') COLLATE "C",
       COALESCE((p_input_cursor -> 'target' ->> 'impactVersion')::integer, 0)
     ) THEN
    RAISE EXCEPTION 'source-revision freshness cursor must advance'
      USING ERRCODE = '22023';
  END IF;

  SELECT run.started_at, run.input_cursor
    INTO v_saved_started_at, v_saved_cursor
  FROM waspada.source_revision_freshness_run_inputs AS run
  WHERE run.trace_id = p_trace_id
  FOR UPDATE;
  IF NOT FOUND OR v_saved_started_at IS DISTINCT FROM v_started_at
     OR v_saved_cursor IS DISTINCT FROM p_input_cursor THEN
    RETURN 'conflict';
  END IF;

  SELECT trace.*
    INTO v_trace
  FROM waspada.traces AS trace
  WHERE trace.trace_id = p_trace_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_trace.dataset_kind IS DISTINCT FROM 'live'
     OR v_trace.started_at IS DISTINCT FROM v_started_at
     OR v_trace.ended_at IS NOT NULL
     OR v_trace.outcome IS DISTINCT FROM 'open'
     OR v_trace.metadata IS DISTINCT FROM v_expected_open_metadata THEN
    RETURN 'conflict';
  END IF;

  SELECT advance.output_cursor
    INTO v_saved_output_cursor
  FROM waspada.source_revision_freshness_run_advances AS advance
  WHERE advance.trace_id = p_trace_id;
  v_has_advance := FOUND;
  IF v_has_advance THEN
    IF v_saved_output_cursor IS NOT DISTINCT FROM p_next_cursor THEN
      RETURN 'replayed';
    END IF;
    RETURN 'conflict';
  END IF;

  SELECT checkpoint.cursor
    INTO v_checkpoint_cursor
  FROM waspada.source_revision_freshness_cursor_checkpoint AS checkpoint
  WHERE checkpoint.singleton = true
  FOR UPDATE;
  IF NOT FOUND OR v_checkpoint_cursor IS DISTINCT FROM v_saved_cursor THEN
    RETURN 'conflict';
  END IF;

  UPDATE waspada.source_revision_freshness_cursor_checkpoint AS checkpoint
  SET cursor = p_next_cursor
  WHERE checkpoint.singleton = true
    AND checkpoint.cursor IS NOT DISTINCT FROM v_saved_cursor;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RETURN 'conflict';
  END IF;

  INSERT INTO waspada.source_revision_freshness_run_advances (trace_id, output_cursor)
  VALUES (p_trace_id, p_next_cursor);
  RETURN 'advanced';
END;
$function$;

CREATE OR REPLACE FUNCTION waspada.finalize_source_revision_freshness_run(
  p_trace_id text,
  p_started_at text,
  p_finished_at text,
  p_outcome text,
  p_summary jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_started_at timestamptz;
  v_finished_at timestamptz;
  v_saved_started_at timestamptz;
  v_trace waspada.traces%ROWTYPE;
  v_has_trace boolean;
  v_has_advance boolean;
  v_final_metadata jsonb;
  v_expected_open_metadata jsonb := pg_catalog.jsonb_build_object(
    'trigger', 'source_revision_freshness_transition'
  );
BEGIN
  IF p_trace_id IS NULL
     OR pg_catalog.char_length(p_trace_id) NOT BETWEEN 1 AND 128
     OR p_trace_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR p_started_at IS NULL OR p_finished_at IS NULL
     OR pg_catalog.char_length(p_started_at) > 64
     OR pg_catalog.char_length(p_finished_at) > 64
     OR pg_catalog.left(p_started_at, 4) = '0000'
     OR pg_catalog.left(p_finished_at, 4) = '0000'
     OR p_started_at !~ '^([0-9]{4})-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'
     OR p_finished_at !~ '^([0-9]{4})-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'
     OR p_outcome IS NULL OR p_outcome NOT IN ('succeeded', 'failed')
     OR NOT waspada.source_revision_freshness_summary_is_valid(p_summary, p_outcome) THEN
    RAISE EXCEPTION 'invalid source-revision freshness finalization input'
      USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_started_at := p_started_at::timestamptz;
    v_finished_at := p_finished_at::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid source-revision freshness finalization input'
      USING ERRCODE = '22023';
  END;
  IF NOT pg_catalog.isfinite(v_started_at)
     OR NOT pg_catalog.isfinite(v_finished_at)
     OR v_finished_at < v_started_at THEN
    RAISE EXCEPTION 'invalid source-revision freshness finalization input'
      USING ERRCODE = '22023';
  END IF;

  v_final_metadata := pg_catalog.jsonb_build_object(
    'trigger', 'source_revision_freshness_transition',
    'summary', p_summary
  );

  SELECT run.started_at
    INTO v_saved_started_at
  FROM waspada.source_revision_freshness_run_inputs AS run
  WHERE run.trace_id = p_trace_id
  FOR UPDATE;
  IF NOT FOUND OR v_saved_started_at IS DISTINCT FROM v_started_at THEN
    RAISE EXCEPTION 'source-revision freshness trace identity conflict'
      USING ERRCODE = '23505';
  END IF;

  SELECT trace.*
    INTO v_trace
  FROM waspada.traces AS trace
  WHERE trace.trace_id = p_trace_id
  FOR UPDATE;
  v_has_trace := FOUND;
  SELECT EXISTS (
    SELECT 1
    FROM waspada.source_revision_freshness_run_advances AS advance
    WHERE advance.trace_id = p_trace_id
  ) INTO v_has_advance;
  IF NOT v_has_trace
     OR v_trace.dataset_kind IS DISTINCT FROM 'live'
     OR v_trace.started_at IS DISTINCT FROM v_started_at THEN
    RAISE EXCEPTION 'source-revision freshness trace identity conflict'
      USING ERRCODE = '23505';
  END IF;

  IF v_trace.outcome = p_outcome
     AND v_trace.ended_at IS NOT DISTINCT FROM v_finished_at
     AND v_trace.metadata IS NOT DISTINCT FROM v_final_metadata
     AND ((p_outcome = 'succeeded') IS NOT DISTINCT FROM v_has_advance) THEN
    RETURN p_outcome;
  END IF;

  IF v_trace.outcome IS DISTINCT FROM 'open'
     OR v_trace.ended_at IS NOT NULL
     OR v_trace.metadata IS DISTINCT FROM v_expected_open_metadata
     OR ((p_outcome = 'succeeded') IS DISTINCT FROM v_has_advance) THEN
    RAISE EXCEPTION 'source-revision freshness trace is not the exact open run'
      USING ERRCODE = '23505';
  END IF;

  UPDATE waspada.traces AS trace
  SET ended_at = v_finished_at,
      outcome = p_outcome,
      metadata = v_final_metadata
  WHERE trace.trace_id = p_trace_id;
  RETURN p_outcome;
END;
$function$;

REVOKE ALL PRIVILEGES ON waspada.source_revision_freshness_cursor_checkpoint,
  waspada.source_revision_freshness_run_inputs,
  waspada.source_revision_freshness_run_advances FROM PUBLIC;

DO $$
DECLARE
  role_name text;
BEGIN
  FOR role_name IN
    SELECT role.rolname
    FROM pg_catalog.pg_roles AS role
    WHERE pg_catalog.left(role.rolname, 8) = 'waspada_'
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON waspada.source_revision_freshness_cursor_checkpoint, '
      'waspada.source_revision_freshness_run_inputs, '
      'waspada.source_revision_freshness_run_advances FROM %I',
      role_name
    );
  END LOOP;
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION
  waspada.source_revision_freshness_cursor_is_valid(jsonb) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  waspada.source_revision_freshness_summary_is_valid(jsonb, text) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  waspada.begin_source_revision_freshness_run(text, text) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  waspada.advance_source_revision_freshness_run(text, text, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  waspada.finalize_source_revision_freshness_run(text, text, text, text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  waspada.source_revision_freshness_cursor_is_valid(jsonb)
  TO waspada_l4_freshness_writer;
GRANT EXECUTE ON FUNCTION
  waspada.source_revision_freshness_summary_is_valid(jsonb, text)
  TO waspada_l4_freshness_writer;
GRANT EXECUTE ON FUNCTION
  waspada.begin_source_revision_freshness_run(text, text)
  TO waspada_l4_freshness_writer;
GRANT EXECUTE ON FUNCTION
  waspada.advance_source_revision_freshness_run(text, text, jsonb, jsonb)
  TO waspada_l4_freshness_writer;
GRANT EXECUTE ON FUNCTION
  waspada.finalize_source_revision_freshness_run(text, text, text, text, jsonb)
  TO waspada_l4_freshness_writer;
