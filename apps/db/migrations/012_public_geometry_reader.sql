-- API-PUBLIC-GEOMETRY-READER-CORE: expose only exact geometry records referenced
-- by the current published live Event payload. This is an internal L4 input view,
-- not a public response projection.
CREATE VIEW waspada.public_event_geometries
WITH (security_barrier = true)
AS
WITH current_live_events AS (
  SELECT event.dataset_kind, event.event_id, event.version, event.record_json
  FROM waspada.public_event_versions AS event
  WHERE event.dataset_kind = 'live'
    AND event.event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND jsonb_typeof(event.record_json) = 'object'
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
    AND jsonb_typeof(event.record_json->'scope') = 'object'
    AND jsonb_typeof(event.record_json->'claims') = 'array'
),
event_scope_geometry_ids AS (
  SELECT event.dataset_kind, reference.value #>> '{}' AS geometry_id
  FROM current_live_events AS event
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(event.record_json->'scope'->'geometry_ids') = 'array'
        THEN event.record_json->'scope'->'geometry_ids'
      ELSE '[]'::jsonb
    END
  ) AS reference(value)
  WHERE jsonb_typeof(reference.value) = 'string'
    AND (reference.value #>> '{}') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
),
claim_scope_geometry_ids AS (
  SELECT event.dataset_kind, reference.value #>> '{}' AS geometry_id
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
  WHERE jsonb_typeof(reference.value) = 'string'
    AND (reference.value #>> '{}') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND EXISTS (
      SELECT 1
      FROM waspada.event_claims AS stored_claim
      WHERE stored_claim.dataset_kind = event.dataset_kind
        AND stored_claim.event_id = event.event_id
        AND stored_claim.event_version = event.version
        AND stored_claim.claim_id = claim.value->>'claim_id'
        AND stored_claim.publication_status = 'published'
        AND stored_claim.record_json = claim.value
    )
    AND EXISTS (
      SELECT 1
      FROM waspada.event_claim_geometries AS linked_geometry
      WHERE linked_geometry.dataset_kind = event.dataset_kind
        AND linked_geometry.event_id = event.event_id
        AND linked_geometry.event_version = event.version
        AND linked_geometry.claim_id = claim.value->>'claim_id'
        AND linked_geometry.geometry_id = reference.value #>> '{}'
    )
),
referenced_geometry_ids AS (
  SELECT dataset_kind, geometry_id FROM event_scope_geometry_ids
  UNION
  SELECT dataset_kind, geometry_id FROM claim_scope_geometry_ids
)
SELECT geometry.dataset_kind, geometry.geometry_id, geometry.record_json
FROM waspada.geometries AS geometry
JOIN referenced_geometry_ids AS reference
  ON reference.dataset_kind = geometry.dataset_kind
 AND reference.geometry_id = geometry.geometry_id
WHERE geometry.dataset_kind = 'live';

-- The reader may access only this filtered view. It receives no geometry or
-- evidence base-table grants; the view owner resolves its underlying relations.
REVOKE ALL PRIVILEGES ON TABLE
  waspada.geometries,
  waspada.geometry_evidence,
  waspada.evidence_references
FROM PUBLIC, waspada_public_reader;

REVOKE ALL PRIVILEGES ON TABLE waspada.public_event_geometries
FROM PUBLIC, waspada_public_reader;

GRANT SELECT ON TABLE waspada.public_event_geometries
TO waspada_public_reader;
