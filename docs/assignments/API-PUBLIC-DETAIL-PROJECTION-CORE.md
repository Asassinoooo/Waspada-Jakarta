# API-PUBLIC-DETAIL-PROJECTION-CORE — bounded EventDetail composition

- **Backlog ID:** `API-PUBLIC-DETAIL-PROJECTION-CORE`
- **Objective:** Compose the accepted current-event snapshot, reviewed public lookup and exact geometry read ports into the existing public `EventDetail` shape through the strict L4 geometry projector.
- **Dependencies:** `API-PUBLIC-SNAPSHOT-CORE`, `API-PUBLIC-LOOKUPS-CORE`, `API-PUBLIC-GEOMETRY-READER-CORE`, `API-PUBLIC-PROJECTION-SERVICE-CORE`, `API-GEOMETRY-CORE`, `ADR-012`.
- **Requirements:** `FR-09/10`, `NFR-01/07`.
- **Allowed paths:** `apps/worker/src/layers/l4-application-integration/public-event-projection-service.ts` (shared validation/preparation refactor only if required); `apps/worker/src/layers/l4-application-integration/public-event-detail-projection-service.ts`; `apps/worker/test/l4-public-event-detail-projection-service.test.ts`; and this assignment's implementation handoff only.
- **Forbidden scope:** No HTTP route, public DTO or OpenAPI change, database adapter, Worker/runtime binding, migration, publication/moderation action, source acquisition, live-source assumption, paid service, dependency, or unrelated path.
- **Branch/worktree:** Use a dedicated branch `work/API-PUBLIC-DETAIL-PROJECTION-CORE` in the prepared task worktree. Start from the root's pushed assignment commit; do not edit through the root checkout.
- **Contract versions:** Public API/OpenAPI stays unchanged. Internal records remain schema 2.0. The existing `projectPublicEventDetail` is the authoritative final allowlist and evidence-support validator.
- **Dependencies/configuration:** No new package or runtime configuration. Use injected structural ports; do not import a database driver into L4.

## Context to read before editing

Read `SOFTWARE_DEVELOPMENT_PLAN.md`, this assignment and its backlog row, then inspect `docs/decisions/ADR-012-public-projection-boundary.md`, `docs/UX_API_SPEC.md`, `docs/api/openapi.yaml`, `apps/worker/src/layers/l4-application-integration/public-event-projection-service.ts`, `public-geometry-projection.ts`, `public-projection.ts`, `apps/db/src/public-event-snapshot.ts`, `public-projection-lookups.ts`, and `public-event-geometries.ts`. Keep database rows as untrusted internal input; never serialize their `recordJson` directly.

## Required behavior

1. Add a read-only injected L4 service returning only `{ kind: "found", detail: EventDetail }` or `{ kind: "missing" }`. Validate the requested event ID before I/O and preserve the existing EventView service behavior.
2. Read one current published live snapshot. Bind the request ID, dataset, event ID/version and each impact identity/version to the returned schema 2.0 payload before issuing downstream reads. Derive only the bounded scope-name and exact supporting-attribution keys required by the existing projector.
3. Derive the unique geometry IDs only from the event and claim scopes. Enforce the L4 geometry cap before calling the geometry port; do not use a broad geometry listing or caller-provided IDs. When there are no references, avoid a geometry read and pass an empty set to the projector.
4. Resolve reviewed lookups and exact geometry rows through injected ports. Reject malformed, duplicate, extra or identity-mismatched results. Keep excerpt fields excluded. Do not return partial detail if any requested scope, attribution, impact or geometry cannot be resolved.
5. Pass the validated snapshot records, reviewed lookups and untrusted geometry `recordJson` values to `projectPublicEventDetail`. Its strict schema, CRS84, topology, size and exact claim-support checks remain authoritative. Stable errors must not include event IDs, lookup keys, geometry, excerpts or database error text.
6. Use authored fictional, live-shaped test fixtures only. A `live` test marker is not real publication, source permission, or factual support. Existing contracts, the ADR-018 application query envelope, demo route and application query limits remain untouched.

## Acceptance criteria

- The service composes only the injected current snapshot, approved lookup results and exact current-reference geometries; it does not publish, mutate or perform network acquisition.
- The geometry reader sees only unique event/claim scope IDs and is not called for empty reference sets. Over-limit or malformed references fail before geometry I/O.
- The existing L4 projector rejects unsupported geometry and returns only existing `EventDetail` allowlist keys; no storage internals or excerpts escape.
- Missing events short-circuit. Port failures, stale/mismatched versions, missing lookups/geometries and malformed rows fail closed with stable redacted errors.
- Tests cover call order, exact key derivation, empty geometry, caps, missing event, wrong identities/versions, unresolved references and proof that projector failures do not return partial details.
- No public contract, migration, route, database binding, dependency or configuration changes.

## Verification (WSL Ubuntu-26.04 only)

Record `node --version`, `npm --version`, `git --version` and relevant package versions. Use existing dependencies. Run the focused test, full `npm test`, `npm run typecheck`, `npm run build` and `git diff --check`. Report each actual result; do not describe hosted Neon or Worker bindings as verified.

## Commit and handoff

Implement only on the assigned branch/worktree. Commit implementation and this assignment's handoff in coherent, descriptive commits. Leave the checkout clean. Do not merge or push. Report exact branch/worktree, SHA(s), commit messages, changed paths, behavior, actual checks/results, limitations, configuration impact and remaining decisions. Root independently reviews and integrates.

## Stop conditions

Stop and report if correct composition requires a public-contract change, route/runtime/database wiring, real source rights, moderator policy, or unsupported factual claim. Continue unrelated safe work within scope where possible. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append the exact branch/worktree, commit(s), changed paths, behavior, actual WSL checks, limitations and remaining decisions here. Do not merge or push.

### Implementation handoff

- **Branch/worktree:** work/API-PUBLIC-DETAIL-PROJECTION-CORE at C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL (WSL: /mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL), based on 876fe6fa8fe129ae68d61c05b9b76c29ddd855f1.
- **Implementation commit:** efed7c22208c3740dff971eb9ec4febe07f3c98f — feat(API-PUBLIC-DETAIL-PROJECTION-CORE): compose live EventDetail projection.
- **Changed implementation paths:** apps/worker/src/layers/l4-application-integration/public-event-detail-projection-service.ts; apps/worker/src/layers/l4-application-integration/public-event-projection-service.ts (shared snapshot preparation export only); apps/worker/test/l4-public-event-detail-projection-service.test.ts.
- **Behavior:** Added a read-only injected service that binds one live snapshot to the request and its event/impact versions, validates exact reviewed lookup results, derives only unique geometry IDs from event and claim scopes, enforces the 500-geometry limit, and reads no geometries for an empty reference set. It passes validated records and untrusted geometry payloads through the existing strict EventDetail projector; errors are stable and redacted. The existing EventView service continues through the same snapshot preparation logic.
- **Checks actually run in WSL Ubuntu-26.04:** Node v24.21.0, npm 11.19.0, Git 2.53.0, TypeScript 7.0.2, tsx 4.23.15, Wrangler 4.137.0, Vite 8.3.0. Focused detail service test: 32/32 passed. npm test: 317/317 passed (web 22, Worker 183, DB 100 across 13 files, evaluation 12). npm run typecheck: passed. npm run build: passed, including Vite production build and Wrangler dry-run. git diff --cached --check: passed. The focused file was run directly because the existing Worker test script enumerates test files and this assignment forbids changing package configuration.
- **Limitations:** Fixtures are fictional and live-shaped only. No actual source permission, factual support, hosted Neon behavior, Worker database binding, HTTP route, live geometry, publication action, or runtime integration was tested or added.
- **Migration/configuration impact:** None. No dependency added.
- **Remaining decisions:** No decision is required within this assignment. A later route/runtime integration needs a separate assignment and remains subject to the documented moderator authorization, source-rights, and runtime-role gates.
- **Handoff commit message:** docs(API-PUBLIC-DETAIL-PROJECTION-CORE): record implementation handoff (its SHA is included in the task report).