-- Fixed-purpose Layer 4 trace functions for due freshness evaluation.
-- The caller can create/resume and finalize only a live freshness run; it cannot
-- choose arbitrary trace metadata or write waspada.traces directly.
CREATE OR REPLACE FUNCTION waspada.begin_freshness_due_evaluation_run(
  p_trace_id text,
  p_started_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_trace waspada.traces%ROWTYPE;
  v_summary jsonb;
  v_summary_key text;
  v_summary_value jsonb;
  v_summary_count numeric;
  v_expected_metadata jsonb;
BEGIN
  IF p_trace_id IS NULL
     OR pg_catalog.char_length(p_trace_id) NOT BETWEEN 1 AND 128
     OR p_trace_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR p_started_at IS NULL
     OR NOT pg_catalog.isfinite(p_started_at) THEN
    RAISE EXCEPTION 'invalid freshness due evaluation run input'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO waspada.traces
    (trace_id, dataset_kind, started_at, ended_at, outcome, metadata)
  VALUES
    (p_trace_id, 'live', p_started_at, NULL, 'open',
     pg_catalog.jsonb_build_object('trigger', 'freshness_due_evaluation'))
  ON CONFLICT (trace_id) DO NOTHING;

  SELECT trace.*
    INTO v_trace
  FROM waspada.traces AS trace
  WHERE trace.trace_id = p_trace_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_trace.dataset_kind IS DISTINCT FROM 'live'
     OR v_trace.started_at IS DISTINCT FROM p_started_at THEN
    RAISE EXCEPTION 'freshness due evaluation trace identity conflict'
      USING ERRCODE = '23505';
  END IF;

  IF v_trace.outcome = 'open' THEN
    IF v_trace.ended_at IS NOT NULL
       OR v_trace.metadata IS DISTINCT FROM
          pg_catalog.jsonb_build_object('trigger', 'freshness_due_evaluation') THEN
      RAISE EXCEPTION 'freshness due evaluation trace identity conflict'
        USING ERRCODE = '23505';
    END IF;
    RETURN 'open';
  END IF;

  IF v_trace.outcome IN ('succeeded', 'failed') THEN
    IF v_trace.ended_at IS NULL
       OR NOT pg_catalog.isfinite(v_trace.ended_at)
       OR v_trace.ended_at < v_trace.started_at THEN
      RAISE EXCEPTION 'freshness due evaluation trace identity conflict'
        USING ERRCODE = '23505';
    END IF;

    v_summary := v_trace.metadata -> 'summary';
    IF pg_catalog.jsonb_typeof(v_summary) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'freshness due evaluation trace identity conflict'
        USING ERRCODE = '23505';
    END IF;
    IF (v_summary - ARRAY['written', 'replayed', 'noChange', 'conflicts', 'failures']) <> '{}'::jsonb
       OR NOT (v_summary ?& ARRAY['written', 'replayed', 'noChange', 'conflicts', 'failures']) THEN
      RAISE EXCEPTION 'freshness due evaluation trace identity conflict'
        USING ERRCODE = '23505';
    END IF;

    FOREACH v_summary_key IN ARRAY ARRAY['written', 'replayed', 'noChange', 'conflicts', 'failures']
    LOOP
      v_summary_value := v_summary -> v_summary_key;
      IF pg_catalog.jsonb_typeof(v_summary_value) IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'freshness due evaluation trace identity conflict'
          USING ERRCODE = '23505';
      END IF;
      v_summary_count := (v_summary ->> v_summary_key)::numeric;
      IF v_summary_count < 0
         OR v_summary_count > 2147483647
         OR pg_catalog.trunc(v_summary_count) <> v_summary_count THEN
        RAISE EXCEPTION 'freshness due evaluation trace identity conflict'
          USING ERRCODE = '23505';
      END IF;
    END LOOP;

    v_expected_metadata := pg_catalog.jsonb_build_object(
      'trigger', 'freshness_due_evaluation',
      'summary', v_summary
    );
    IF v_trace.metadata IS DISTINCT FROM v_expected_metadata THEN
      RAISE EXCEPTION 'freshness due evaluation trace identity conflict'
        USING ERRCODE = '23505';
    END IF;

    RETURN v_trace.outcome;
  END IF;

  RAISE EXCEPTION 'freshness due evaluation trace identity conflict'
    USING ERRCODE = '23505';
END;
$function$;

CREATE OR REPLACE FUNCTION waspada.finalize_freshness_due_evaluation_run(
  p_trace_id text,
  p_started_at timestamptz,
  p_finished_at timestamptz,
  p_outcome text,
  p_summary jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_trace waspada.traces%ROWTYPE;
  v_summary_key text;
  v_summary_value jsonb;
  v_summary_count numeric;
  v_final_metadata jsonb;
BEGIN
  IF p_trace_id IS NULL
     OR pg_catalog.char_length(p_trace_id) NOT BETWEEN 1 AND 128
     OR p_trace_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR p_started_at IS NULL
     OR NOT pg_catalog.isfinite(p_started_at)
     OR p_finished_at IS NULL
     OR NOT pg_catalog.isfinite(p_finished_at)
     OR p_finished_at < p_started_at
     OR p_outcome IS NULL
     OR p_outcome NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'invalid freshness due evaluation run input'
      USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.jsonb_typeof(p_summary) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid freshness due evaluation count summary'
      USING ERRCODE = '22023';
  END IF;
  IF (p_summary - ARRAY['written', 'replayed', 'noChange', 'conflicts', 'failures']) <> '{}'::jsonb
     OR NOT (p_summary ?& ARRAY['written', 'replayed', 'noChange', 'conflicts', 'failures']) THEN
    RAISE EXCEPTION 'invalid freshness due evaluation count summary'
      USING ERRCODE = '22023';
  END IF;

  FOREACH v_summary_key IN ARRAY ARRAY['written', 'replayed', 'noChange', 'conflicts', 'failures']
  LOOP
    v_summary_value := p_summary -> v_summary_key;
    IF pg_catalog.jsonb_typeof(v_summary_value) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'invalid freshness due evaluation count summary'
        USING ERRCODE = '22023';
    END IF;
    v_summary_count := (p_summary ->> v_summary_key)::numeric;
    IF v_summary_count < 0
       OR v_summary_count > 2147483647
       OR pg_catalog.trunc(v_summary_count) <> v_summary_count THEN
      RAISE EXCEPTION 'invalid freshness due evaluation count summary'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  v_final_metadata := pg_catalog.jsonb_build_object(
    'trigger', 'freshness_due_evaluation',
    'summary', p_summary
  );

  SELECT trace.*
    INTO v_trace
  FROM waspada.traces AS trace
  WHERE trace.trace_id = p_trace_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_trace.dataset_kind IS DISTINCT FROM 'live'
     OR v_trace.started_at IS DISTINCT FROM p_started_at THEN
    RAISE EXCEPTION 'freshness due evaluation trace identity conflict'
      USING ERRCODE = '23505';
  END IF;

  IF v_trace.outcome = p_outcome
     AND v_trace.ended_at IS NOT DISTINCT FROM p_finished_at
     AND v_trace.metadata IS NOT DISTINCT FROM v_final_metadata THEN
    RETURN p_outcome;
  END IF;

  IF v_trace.outcome IS DISTINCT FROM 'open'
     OR v_trace.ended_at IS NOT NULL
     OR v_trace.metadata IS DISTINCT FROM
        pg_catalog.jsonb_build_object('trigger', 'freshness_due_evaluation') THEN
    RAISE EXCEPTION 'freshness due evaluation trace is not the exact open run'
      USING ERRCODE = '23505';
  END IF;

  UPDATE waspada.traces AS trace
  SET ended_at = p_finished_at,
      outcome = p_outcome,
      metadata = v_final_metadata
  WHERE trace.trace_id = p_trace_id;

  RETURN p_outcome;
END;
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION
  waspada.begin_freshness_due_evaluation_run(text, timestamptz) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  waspada.finalize_freshness_due_evaluation_run(text, timestamptz, timestamptz, text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  waspada.begin_freshness_due_evaluation_run(text, timestamptz)
  TO waspada_l4_freshness_writer;
GRANT EXECUTE ON FUNCTION
  waspada.finalize_freshness_due_evaluation_run(text, timestamptz, timestamptz, text, jsonb)
  TO waspada_l4_freshness_writer;
