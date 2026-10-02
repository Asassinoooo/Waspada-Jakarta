-- Overlay only the effective freshness status onto exact current-public event
-- and impact records. The append-only ledger remains private to view owners and L4.
CREATE OR REPLACE VIEW waspada.public_event_versions
WITH (security_barrier = true)
AS
WITH current_published_events AS (
  SELECT event.dataset_kind, event.event_id, event.version, event.title, event.summary,
         event.category, event.lifecycle, event.record_json,
         COALESCE(claim_transition.resulting_status,
                  event.record_json #>> '{freshness,status}') AS claim_set_status
  FROM waspada.event_versions AS event
  JOIN waspada.dataset_namespace_config AS config
    ON config.dataset_kind = event.dataset_kind
  LEFT JOIN LATERAL (
    SELECT transition.resulting_status
    FROM waspada.freshness_transitions AS transition
    WHERE transition.dataset_kind = event.dataset_kind
      AND transition.event_id = event.event_id
      AND transition.event_version = event.version
      AND transition.target_kind = 'event_claim_set'
    ORDER BY transition.transition_sequence DESC
    LIMIT 1
  ) AS claim_transition ON true
  WHERE event.publication_status = 'published'
    AND NOT EXISTS (
      SELECT 1
      FROM waspada.event_versions AS newer
      WHERE newer.dataset_kind = event.dataset_kind
        AND newer.event_id = event.event_id
        AND newer.version > event.version
    )
),
aggregated_events AS (
  SELECT event.dataset_kind, event.event_id, event.version, event.title, event.summary,
         event.category, event.lifecycle, event.record_json,
         CASE
           WHEN event.claim_set_status IS NULL
             OR event.claim_set_status NOT IN ('current', 'needs_update', 'expired')
             THEN 'needs_update'
           WHEN COALESCE(impact_freshness.has_invalid, false)
             OR COALESCE(impact_freshness.has_needs_update, false)
             THEN 'needs_update'
           WHEN event.claim_set_status = 'current'
             AND COALESCE(impact_freshness.has_expired, false)
             THEN 'needs_update'
           WHEN event.claim_set_status = 'expired'
             AND COALESCE(impact_freshness.has_current, false)
             THEN 'needs_update'
           WHEN event.claim_set_status = 'current' THEN 'current'
           WHEN event.claim_set_status = 'expired' THEN 'expired'
           ELSE 'needs_update'
         END AS freshness_status
  FROM current_published_events AS event
  LEFT JOIN LATERAL (
    SELECT BOOL_OR(item.status IS NULL OR item.status NOT IN ('current', 'needs_update', 'expired')) AS has_invalid,
           BOOL_OR(item.status = 'needs_update') AS has_needs_update,
           BOOL_OR(item.status = 'current') AS has_current,
           BOOL_OR(item.status = 'expired') AS has_expired
    FROM (
      SELECT COALESCE(impact_transition.resulting_status,
                      impact.record_json #>> '{freshness,status}') AS status
      FROM waspada.event_impact_refs AS reference
      LEFT JOIN waspada.impact_versions AS impact
        ON impact.dataset_kind = reference.dataset_kind
       AND impact.event_id = reference.event_id
       AND impact.event_version = reference.event_version
       AND impact.impact_id = reference.impact_id
       AND impact.version = reference.impact_version
      LEFT JOIN LATERAL (
        SELECT transition.resulting_status
        FROM waspada.freshness_transitions AS transition
        WHERE transition.dataset_kind = reference.dataset_kind
          AND transition.event_id = reference.event_id
          AND transition.event_version = reference.event_version
          AND transition.target_kind = 'impact'
          AND transition.impact_id = reference.impact_id
          AND transition.impact_version = reference.impact_version
        ORDER BY transition.transition_sequence DESC
        LIMIT 1
      ) AS impact_transition ON true
      WHERE reference.dataset_kind = event.dataset_kind
        AND reference.event_id = event.event_id
        AND reference.event_version = event.version
    ) AS item
  ) AS impact_freshness ON true
)
SELECT event.dataset_kind, event.event_id, event.version, event.title, event.summary,
       event.category, event.lifecycle,
       CASE
         WHEN jsonb_typeof(event.record_json->'freshness') = 'object'
           THEN jsonb_set(event.record_json, '{freshness,status}',
                          to_jsonb(event.freshness_status), true)
         ELSE jsonb_set(event.record_json, '{freshness}',
                        jsonb_build_object('status', event.freshness_status), true)
       END AS record_json,
       event.freshness_status
FROM aggregated_events AS event;

-- Impacts receive their own exact-version transition while the event row above
-- computes its conservative aggregate. Neither view updates stored publication data.
CREATE OR REPLACE VIEW waspada.public_event_impacts
WITH (security_barrier = true)
AS
SELECT current_event.dataset_kind, current_event.event_id,
       current_event.version AS event_version,
       impact.impact_id, impact.version AS impact_version, impact.impact_type,
       impact.lifecycle,
       CASE
         WHEN impact_transition.resulting_status IS NULL THEN impact.record_json
         WHEN jsonb_typeof(impact.record_json->'freshness') = 'object'
           THEN jsonb_set(impact.record_json, '{freshness,status}',
                          to_jsonb(impact_transition.resulting_status), true)
         ELSE jsonb_set(impact.record_json, '{freshness}',
                        jsonb_build_object('status', impact_transition.resulting_status), true)
       END AS record_json
FROM waspada.public_event_versions AS current_event
JOIN waspada.event_impact_refs AS reference
  ON reference.dataset_kind = current_event.dataset_kind
 AND reference.event_id = current_event.event_id
 AND reference.event_version = current_event.version
JOIN waspada.impact_versions AS impact
  ON impact.dataset_kind = reference.dataset_kind
 AND impact.event_id = reference.event_id
 AND impact.impact_id = reference.impact_id
 AND impact.version = reference.impact_version
LEFT JOIN LATERAL (
  SELECT transition.resulting_status
  FROM waspada.freshness_transitions AS transition
  WHERE transition.dataset_kind = reference.dataset_kind
    AND transition.event_id = reference.event_id
    AND transition.event_version = reference.event_version
    AND transition.target_kind = 'impact'
    AND transition.impact_id = reference.impact_id
    AND transition.impact_version = reference.impact_version
  ORDER BY transition.transition_sequence DESC
  LIMIT 1
) AS impact_transition ON true;