-- Derive the event badge from its grouped claim-set freshness and the exact
-- impact versions referenced by the current published event. This status is
-- reader metadata; the immutable Event record JSON remains unchanged.
CREATE OR REPLACE VIEW waspada.public_event_versions
WITH (security_barrier = true)
AS
SELECT event.dataset_kind, event.event_id, event.version, event.title, event.summary,
       event.category, event.lifecycle, event.record_json,
       CASE
         WHEN event.record_json #>> '{freshness,status}' IS NULL
           OR event.record_json #>> '{freshness,status}' NOT IN ('current', 'needs_update', 'expired')
           THEN 'needs_update'
         WHEN COALESCE(impact_freshness.has_invalid, false)
           OR COALESCE(impact_freshness.has_needs_update, false)
           THEN 'needs_update'
         WHEN event.record_json #>> '{freshness,status}' = 'current'
           AND COALESCE(impact_freshness.has_expired, false)
           THEN 'needs_update'
         WHEN event.record_json #>> '{freshness,status}' = 'expired'
           AND COALESCE(impact_freshness.has_current, false)
           THEN 'needs_update'
         WHEN event.record_json #>> '{freshness,status}' = 'current' THEN 'current'
         WHEN event.record_json #>> '{freshness,status}' = 'expired' THEN 'expired'
         ELSE 'needs_update'
       END AS freshness_status
FROM waspada.event_versions AS event
JOIN waspada.dataset_namespace_config AS config
  ON config.dataset_kind = event.dataset_kind
LEFT JOIN LATERAL (
  SELECT BOOL_OR(item.status IS NULL OR item.status NOT IN ('current', 'needs_update', 'expired')) AS has_invalid,
         BOOL_OR(item.status = 'needs_update') AS has_needs_update,
         BOOL_OR(item.status = 'current') AS has_current,
         BOOL_OR(item.status = 'expired') AS has_expired
  FROM (
    SELECT impact.record_json #>> '{freshness,status}' AS status
    FROM waspada.event_impact_refs AS reference
    LEFT JOIN waspada.impact_versions AS impact
      ON impact.dataset_kind = reference.dataset_kind
     AND impact.event_id = reference.event_id
     AND impact.event_version = reference.event_version
     AND impact.impact_id = reference.impact_id
     AND impact.version = reference.impact_version
    WHERE reference.dataset_kind = event.dataset_kind
      AND reference.event_id = event.event_id
      AND reference.event_version = event.version
  ) AS item
) AS impact_freshness ON true
WHERE event.publication_status = 'published'
  AND NOT EXISTS (
    SELECT 1
    FROM waspada.event_versions AS newer
    WHERE newer.dataset_kind = event.dataset_kind
      AND newer.event_id = event.event_id
      AND newer.version > event.version
  );

-- Keep the internal GeoJSON candidate freshness column on the same derived
-- status while retaining its exact current-public geometry and claim joins.
CREATE OR REPLACE VIEW waspada.public_event_geojson_candidates
WITH (security_barrier = true)
AS
WITH event_record_keys AS (
  SELECT ARRAY[
    'schema_version', 'trace_id', 'record_type', 'dataset_kind', 'event_id', 'version',
    'supersedes_version', 'title', 'summary', 'category', 'tags', 'lifecycle', 'freshness',
    'event_time', 'validity', 'scope', 'claims', 'impact_refs', 'publication_status',
    'withdrawal_reason', 'publication_decision_id', 'published_at', 'withdrawn_at'
  ]::text[] AS keys
), current_live_events AS (
  SELECT event.dataset_kind, event.event_id, event.version, event.category,
         event.lifecycle, event.freshness_status, event.record_json
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
    AND jsonb_typeof(event.record_json->'category') = 'string'
    AND event.record_json->>'category' = event.category
    AND event.category IN (
      'crime_personal_security', 'demonstrations_public_gatherings', 'crowds_major_events',
      'violence_immediate_threats', 'disasters_weather', 'fires_infrastructure_hazards',
      'transport_road_incidents', 'utilities_essential_services',
      'health_environmental_advisories', 'group_specific_critical_notices'
    )
    AND jsonb_typeof(event.record_json->'lifecycle') = 'string'
    AND event.record_json->>'lifecycle' = event.lifecycle
    AND event.lifecycle IN ('planned', 'ongoing', 'resolved', 'cancelled', 'unknown')
    AND jsonb_typeof(event.record_json->'freshness') = 'object'
    AND jsonb_typeof(event.record_json #> '{freshness,status}') = 'string'
    AND event.record_json #>> '{freshness,status}' IN ('current', 'needs_update', 'expired')
    AND event.freshness_status IN ('current', 'needs_update', 'expired')
    AND jsonb_typeof(event.record_json->'claims') = 'array'
), claim_geometry_references AS (
  SELECT event.dataset_kind, event.event_id, event.version AS event_version,
         event.category, event.lifecycle, event.freshness_status AS freshness,
         event.record_json AS event_record_json,
         linked_geometry.geometry_id
  FROM current_live_events AS event
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(event.record_json->'claims') = 'array'
        THEN event.record_json->'claims'
      ELSE '[]'::jsonb
    END
  ) AS claim(value)
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(claim.value) = 'object'
        AND jsonb_typeof(claim.value->'claim_id') = 'string'
        AND (claim.value->>'claim_id') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        AND jsonb_typeof(claim.value->'scope') = 'object'
        AND jsonb_typeof(claim.value->'scope'->'geometry_ids') = 'array'
        THEN claim.value->'scope'->'geometry_ids'
      ELSE '[]'::jsonb
    END
  ) AS reference(value)
  JOIN waspada.event_claims AS stored_claim
    ON stored_claim.dataset_kind = event.dataset_kind
   AND stored_claim.event_id = event.event_id
   AND stored_claim.event_version = event.version
   AND stored_claim.claim_id = claim.value->>'claim_id'
   AND stored_claim.publication_status = 'published'
   AND stored_claim.record_json = claim.value
  JOIN waspada.event_claim_geometries AS linked_geometry
    ON linked_geometry.dataset_kind = stored_claim.dataset_kind
   AND linked_geometry.event_id = stored_claim.event_id
   AND linked_geometry.event_version = stored_claim.event_version
   AND linked_geometry.claim_id = stored_claim.claim_id
   AND linked_geometry.geometry_id = reference.value #>> '{}'
  WHERE jsonb_typeof(reference.value) = 'string'
    AND (reference.value #>> '{}') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
), unique_claim_geometry_references AS (
  SELECT DISTINCT dataset_kind, event_id, event_version, category, lifecycle, freshness,
                  event_record_json, geometry_id
  FROM claim_geometry_references
)
SELECT candidate.dataset_kind, candidate.event_id, candidate.event_version,
       candidate.category, candidate.lifecycle, candidate.freshness,
       candidate.geometry_id, candidate.event_record_json,
       geometry.record_json AS geometry_record_json,
       geometry.shape
FROM unique_claim_geometry_references AS candidate
JOIN waspada.geometries AS geometry
  ON geometry.dataset_kind = candidate.dataset_kind
 AND geometry.geometry_id = candidate.geometry_id
WHERE geometry.dataset_kind = 'live';
