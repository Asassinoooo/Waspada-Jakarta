-- API-PUBLIC-HISTORY-READER-CORE: expose published versions only while the
-- event remains a current public live event. The JSON records stay internal
-- input for Layer 4 projection.
CREATE VIEW waspada.public_event_history_versions
WITH (security_barrier = true)
AS
WITH event_record_keys AS (
  SELECT ARRAY[
    'schema_version', 'trace_id', 'record_type', 'dataset_kind', 'event_id', 'version',
    'supersedes_version', 'title', 'summary', 'category', 'tags', 'lifecycle', 'freshness',
    'event_time', 'validity', 'scope', 'claims', 'impact_refs', 'publication_status',
    'withdrawal_reason', 'publication_decision_id', 'published_at', 'withdrawn_at'
  ]::text[] AS keys
),
current_live_events AS (
  SELECT event.dataset_kind, event.event_id, event.version AS current_version
  FROM waspada.public_event_versions AS event
  CROSS JOIN event_record_keys
  WHERE event.dataset_kind = 'live'
    AND event.event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND jsonb_typeof(event.record_json) = 'object'
    AND event.record_json ?& event_record_keys.keys
    AND (event.record_json - event_record_keys.keys) = '{}'::jsonb
    AND jsonb_typeof(event.record_json->'schema_version') = 'string'
    AND event.record_json->>'schema_version' = '2.0'
    AND jsonb_typeof(event.record_json->'record_type') = 'string'
    AND event.record_json->>'record_type' = 'Event'
    AND jsonb_typeof(event.record_json->'trace_id') = 'string'
    AND event.record_json->>'trace_id' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND jsonb_typeof(event.record_json->'dataset_kind') = 'string'
    AND event.record_json->>'dataset_kind' = event.dataset_kind
    AND jsonb_typeof(event.record_json->'event_id') = 'string'
    AND event.record_json->>'event_id' = event.event_id
    AND jsonb_typeof(event.record_json->'version') = 'number'
    AND event.record_json->'version' = to_jsonb(event.version)
    AND jsonb_typeof(event.record_json->'publication_status') = 'string'
    AND event.record_json->>'publication_status' = 'published'
)
SELECT version.dataset_kind, version.event_id, version.version, version.record_json
FROM waspada.event_versions AS version
JOIN current_live_events AS current_event
  ON current_event.dataset_kind = version.dataset_kind
 AND current_event.event_id = version.event_id
CROSS JOIN event_record_keys
WHERE version.dataset_kind = 'live'
  AND version.publication_status = 'published'
  AND version.version <= current_event.current_version
  AND version.event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  AND jsonb_typeof(version.record_json) = 'object'
  AND version.record_json ?& event_record_keys.keys
  AND (version.record_json - event_record_keys.keys) = '{}'::jsonb
  AND jsonb_typeof(version.record_json->'schema_version') = 'string'
  AND version.record_json->>'schema_version' = '2.0'
  AND jsonb_typeof(version.record_json->'record_type') = 'string'
  AND version.record_json->>'record_type' = 'Event'
  AND jsonb_typeof(version.record_json->'trace_id') = 'string'
  AND version.record_json->>'trace_id' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  AND jsonb_typeof(version.record_json->'dataset_kind') = 'string'
  AND version.record_json->>'dataset_kind' = version.dataset_kind
  AND jsonb_typeof(version.record_json->'event_id') = 'string'
  AND version.record_json->>'event_id' = version.event_id
  AND jsonb_typeof(version.record_json->'version') = 'number'
  AND version.record_json->'version' = to_jsonb(version.version)
  AND jsonb_typeof(version.record_json->'publication_status') = 'string'
  AND version.record_json->>'publication_status' = 'published';

-- The public-reader role reads history through this filtered view. It has no
-- direct access to publication, event-version, or private source tables.
REVOKE ALL PRIVILEGES ON TABLE
  waspada.event_versions,
  waspada.event_claims,
  waspada.event_claim_evidence,
  waspada.event_claim_origins,
  waspada.event_claim_geometries,
  waspada.publication_decisions,
  waspada.publication_claim_decisions,
  waspada.publication_decision_evidence,
  waspada.impact_versions,
  waspada.impact_claim_support,
  waspada.event_impact_refs,
  waspada.source_registry,
  waspada.report_revisions,
  waspada.evidence_references
FROM PUBLIC, waspada_public_reader;

REVOKE ALL PRIVILEGES ON TABLE waspada.public_event_history_versions
FROM PUBLIC, waspada_public_reader;

GRANT SELECT ON TABLE waspada.public_event_history_versions
TO waspada_public_reader;
