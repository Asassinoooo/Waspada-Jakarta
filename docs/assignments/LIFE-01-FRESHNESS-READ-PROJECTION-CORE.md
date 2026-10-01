# LIFE-01-FRESHNESS-READ-PROJECTION-CORE — overlay current published freshness status

**Status:** Assigned for isolated implementation under accepted [ADR-038](../decisions/ADR-038-append-only-freshness-transitions.md).  
**Backlog ID:** `LIFE-01-FRESHNESS-READ-PROJECTION-CORE`  
**Implementation model:** GPT-6 Luna, max reasoning  
**Branch:** `work/LIFE-01-FRESHNESS-READ-PROJECTION-CORE`  
**Worktree:** Root creates a dedicated worktree from the exact local `main` commit named in the dispatch.  
**Contract baseline:** Schema 2.0 event/impact records and existing public DTO/OpenAPI contract; no API shape change.

## Context and dependencies

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`, `docs/IMPLEMENTATION_BACKLOG.md`, ADR-032, ADR-038, and the accepted transition, aggregate, and ledger assignments/handoffs before editing.

The append-only freshness ledger now records Layer 4 transitions against an exact latest published event version and its exact referenced impact versions. Public event and impact rows remain immutable. The user selected status-only projection: preserve published `evaluated_at`, `review_due_at`, and `basis`; keep claims grouped under event-level freshness; preserve each impact's own freshness metadata. Withdrawn versions and all public history for an event whose latest version is withdrawn remain hidden.

The current public readers use security-barrier views. They should project effective status into current event/impact `record_json` so existing Layer 4 validation and public DTOs receive the same shape, while the internal event `freshness_status` column continues to drive list and GeoJSON filtering. Public roles must continue to lack direct ledger access. Historical event-version records keep the freshness status published for that version; only the exact current published version receives a ledger overlay.

Dependencies: `LIFE-01-FRESHNESS-TRANSITION-CORE`, `LIFE-01-FRESHNESS-AGGREGATE-CORE`, `LIFE-01-FRESHNESS-LEDGER-CORE`, `API-01`, and ADR-032/038.

## Objective

Project the latest append-only freshness status onto the existing current-public event and impact read views. Preserve the existing API/DTO contract and every published metadata field, and keep ledger storage private to the database view owner and Layer 4 writer.

## Required behavior

1. For a current published event, use the latest transition by target sequence only when `(dataset_kind, event_id, event_version)` exactly matches that current version and `target_kind` is `event_claim_set`. If there is no transition, use the status embedded in the immutable event record.
2. For an impact, use the latest transition only when it matches the current event version and its exact `(impact_id, impact_version)` reference. If there is no transition, use the status embedded in the immutable impact record. Never carry a transition across a new event or impact version.
3. Derive the event's aggregate status using ADR-032 over the effective grouped claim-set and exact referenced impact statuses: any `needs_update`, invalid/missing status, or mixed `current`/`expired` yields `needs_update`; `expired` applies only when all public items are expired; otherwise all-current items yield `current`. An event without impacts uses its claim-set status.
4. Overlay only `freshness.status` in projected event/impact JSON. Preserve immutable `evaluated_at`, `review_due_at`, and `basis`; leave every stored event/impact record and publication row unchanged. Keep the internal event `freshness_status` value aligned with projected event JSON so list and GeoJSON filters see the same status as detail reads.
5. The current-public views continue to hide withdrawn events and remain restricted to the configured dataset. The public reader can query the safe views but cannot select from either private ledger table. Do not change history/update-version statuses; historical versions retain their published freshness, and an event whose latest version is withdrawn continues to expose no event or history.
6. Do not interpret `expired` or an empty report set as resolved or physically safe. This task only changes a freshness status field and creates no danger radius or geometry.

## Allowed paths

- `apps/db/migrations/025_freshness_current_public_overlay.sql` (new)
- `apps/db/test/migrations.test.ts` (migration inventory/order and role-access checks)
- `apps/db/test/public-event-snapshot.test.ts` (current event/impact detail read overlay)
- `apps/db/test/public-event-list.test.ts` (filter status and pagination alignment)
- `apps/db/test/public-event-geojson-candidates.test.ts` (status filter and bounded-candidate alignment)
- `apps/db/test/public-event-history.test.ts` (published historical status remains unchanged)
- `apps/db/test/public-event-updates.test.ts` (staged migration inventory only)
- `docs/assignments/LIFE-01-FRESHNESS-READ-PROJECTION-CORE-HANDOFF.md` (new)

Do not change the ledger write path, transition policy, event/impact storage, current API/OpenAPI/DTOs, UI, publication authorization, source adapters, model providers, scheduler/clock, outbox, deployment configuration, dependency versions, or unrelated tests. Stop and ask root before any additional path becomes necessary.

## Acceptance and verification

- PGlite fixtures prove no-transition fallback, latest sequence selection, exact event/impact-version binding, and that transitions on an older event version or an unreferenced impact never affect current reads.
- Under `waspada_public_reader`, current detail/snapshot JSON carries status-only overlays, metadata remains byte/field-identical, aggregate status follows ADR-032, and direct reads of both ledger tables are denied.
- List and GeoJSON freshness filters agree with the overlaid event JSON and run before page/feature limits. Historical event versions retain their published freshness; withdrawn versions and history stay hidden.
- Tests assert stored event/impact JSON, publication decisions, and outbox rows remain unchanged. All inputs are authored synthetic fixtures; no source/provider is contacted.
- Run in WSL Ubuntu-26.04 with the existing dependency tree: focused snapshot/list/GeoJSON/history/migration tests, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record actual counts and versions; do not install dependencies or contact external services.
- Commit implementation and handoff separately on the assigned branch. Root reviews independently and integrates accepted commits; the agent does not merge or push.

## Stop conditions

Stop and ask root if the public reader would need direct ledger grants, a public contract/DTO change, a change to immutable publication data, a deviation from ADR-032's aggregate, exposure of withdrawn history, or scheduler/source behavior. Do not add time evaluation or new transition writes in this projection task.
