# ADR-025 — Exact-live transient briefing runtime

- **Status:** Accepted, 27 September 2026
- **Owners:** Root planner/reviewer

## Context

The public briefing contract is a transient `POST /api/v1/briefings` request with at most 100 projected `EventView` results. Exact-interest selection now has a pure Layer 4 projector and a bounded public-view candidate reader. The runtime still needs to read candidate identities, exact current snapshots, and approved projection lookups before constructing the response. Separate `READ COMMITTED` statements could observe different publication states while these reads run.

## Decision

- Serve the briefing only when the server explicitly selects `DATASET_MODE=live` and the exact-live runtime is configured. Demo mode never computes or displays synthetic relevance; missing configuration and unsupported modes return a bounded unavailable response.
- Keep the request transient. Validate the unchanged `BriefingRequest`, call the exact candidate reader, project only current-public exact-version snapshots through the strict Layer 4 event projection, and recheck each event through `API-BRIEFING-PROJECTION-CORE`. Preserve candidate ordering, event status, freshness, timestamps, and evidence. A missing event, version mismatch, invalid projection, database failure, or candidate overflow fails the whole response without partial items.
- Execute candidate selection, snapshot reads, and approved lookup reads through one request-scoped SQL executor in a `REPEATABLE READ READ ONLY` transaction. Commit only after the complete validated response is built; roll back on failure. This keeps every read on one database snapshot without adding any writes.
- Bound the JSON body to 256 KiB, accept only JSON, and stream-count actual bytes before parsing. Invalid UTF-8/JSON, oversized bodies, unknown fields, and malformed or oversized interests receive a stable 400 response. The limit accommodates all valid contract interests in escaped JSON while bounding excessive transport padding.
- Emit only the existing `BriefingResponse`; do not change OpenAPI or DTOs. Use `no-store` response headers and existing privacy-safe route telemetry; never log or persist interest values.
- Current-public views remain the only source of events and exact linked impacts. The initial published timestamp may be read solely as the immutable candidate ordering key; no old version is serialized or returned. Withdrawn versions and all public event history after the latest version is withdrawn remain hidden.

## Consequences

- The checked-in demo Worker continues to report the route unavailable until an operator deliberately configures the live mode and Hyperdrive binding; it has no live source connectors today.
- One bounded request may project up to 100 candidates. Query latency, ICU collation availability, and Neon Free physical cost remain unverified until an approved hosted compatibility test.
- This decision authorizes no preference persistence, model invocation, source acquisition, publication write, moderator action, browser briefing UI, update feed, deployment, or provider resource.

## Affected requirements

US-02; FR-09/11; NFR-01/04/05/07/08.
