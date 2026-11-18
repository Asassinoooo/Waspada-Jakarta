-- 057_pipeline_cycle_runs.sql
-- HOSTED-30 (owner decision, 18 Nov 2026): one row per hosted `--once` ingest run, so the moderator flow view (`#alur-agen`)
-- can show the last polling cycle on the hosted site. The hosted Worker runs in another process, so the in-process runtime
-- status is not there and the database is the only state both sides share. The row holds counts, timings and an exit code.
-- It holds no title, URL, prompt, model output or error text. `record_json` is a JSON object of numeric counts only.
-- Forward-only. It adds one table, one INSERT grant for the L1 ingest writer, one SELECT grant for the flow reader, and two
-- column-level SELECT grants on source_registry for the flow reader (last check and last success times). The flow reader
-- gets no write right anywhere, and the LIFE-01 freshness-writer pause is untouched.

CREATE TABLE IF NOT EXISTS waspada.pipeline_cycle_runs (
  dataset_kind text NOT NULL CHECK (dataset_kind IN ('live', 'historical', 'synthetic')),
  run_id text NOT NULL CHECK (length(run_id) BETWEEN 1 AND 200),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  elapsed_ms integer NOT NULL CHECK (elapsed_ms >= 0),
  feeds_ok integer NOT NULL CHECK (feeds_ok >= 0),
  feeds_failed integer NOT NULL CHECK (feeds_failed >= 0),
  items_new integer NOT NULL CHECK (items_new >= 0),
  ai_completed integer NOT NULL CHECK (ai_completed >= 0),
  ai_not_completed integer NOT NULL CHECK (ai_not_completed >= 0),
  published integer NOT NULL CHECK (published >= 0),
  held integer NOT NULL CHECK (held >= 0),
  exit_code integer NOT NULL CHECK (exit_code BETWEEN 0 AND 255),
  record_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(record_json) = 'object'),
  PRIMARY KEY (dataset_kind, run_id),
  CHECK (finished_at >= started_at)
);

CREATE INDEX IF NOT EXISTS pipeline_cycle_runs_latest_idx
  ON waspada.pipeline_cycle_runs (dataset_kind, finished_at DESC, run_id DESC);

REVOKE ALL ON waspada.pipeline_cycle_runs FROM PUBLIC;
GRANT INSERT ON waspada.pipeline_cycle_runs TO waspada_l1_pipeline;
GRANT SELECT ON waspada.pipeline_cycle_runs TO waspada_l4_pipeline_flow_reader;

GRANT SELECT (last_checked_at, last_success_at)
  ON TABLE waspada.source_registry TO waspada_l4_pipeline_flow_reader;
