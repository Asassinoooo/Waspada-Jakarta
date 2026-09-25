# API-PROJECT-CORE — Layer 4 public whitelist projection

- **Status:** Assigned
- **Depends on:** BOOT-01, SPEC-02, SPEC-03, ADR-012
- **Requirements:** FR-09/10; NFR-01/07
- **Branch/worktree:** `work/API-PROJECT-CORE`; `.codex-build/worktrees/api-project-core`
- **Owner:** GPT-6 Luna Max implementation agent; root plans and reviews

## Objective

Implement a pure, fail-closed Layer 4 projector from untrusted schema 2.0 event/impact records and pre-authorized lookup inputs to the existing public API `EventView`. Construct every response field from an explicit allowlist. This is projection tooling only: it does not query a database, serve a route, authorize sources, publish events, or establish factual accuracy.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`, Sections 4, 6, 7 and 10
- `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/DOMAIN_MODEL.md`, especially the record, dataset and projection rules
- `docs/UX_API_SPEC.md`, especially Sections 2, 6.2 and 7
- `docs/api/openapi.yaml`, `docs/contracts.schema.json`
- `docs/decisions/ADR-012-public-projection-boundary.md`
- `apps/worker/src/contracts/public-api.ts`
- `apps/worker/src/layers/l4-application-integration/public-read-model.ts`
- Existing Worker tests and package scripts

## Required behavior

- Accept `unknown` schema 2.0 Event and Impact records at the runtime boundary. Validate every consumed field and relevant identity/version invariant; TypeScript interfaces alone are not runtime validation. Ignore or reject unknown storage-only fields, but never copy them into output.
- Project only `dataset_kind: live` events with `publication_status: published`, a valid publication time, and a valid supported category/lifecycle/freshness/time/scope/claim shape. Historical, synthetic, withdrawn, malformed, or unresolved records return a bounded typed error without echoing input.
- Resolve place, service, institution and audience IDs through injected display-name lookups. Missing, ambiguous, or invalid labels fail closed; never display an internal ID as a name. Geometry stays outside `EventView` and is not projected here.
- Resolve each published claim's support references by exact report revision, permitted-text hash, code-point span and `supports` relation against injected public-attribution inputs. Require each matched attribution to declare public-use approval, validate HTTPS URLs and timestamps, and emit only `display_name`, `url`, `published_at`, `observed_at`, and a permission-approved excerpt or `null`. Do not derive an independence claim or turn contradiction/context evidence into a source attribution.
- Resolve every `impact_ref` to exactly one Impact with the same dataset, event ID, event version, impact ID and impact version. Missing, duplicate, mismatched, or unreferenced impacts fail closed.
- Construct exact public `EventView`, `PublicClaim`, and `PublicImpact` objects. Omit dataset/trace/decision/model fields, evidence hashes/offsets/revision IDs, origins, support arrays, internal scope IDs and supporting claim IDs. Do not use object spread on stored JSON or resolver records.
- Add authored synthetic/live-shaped test objects only. Clearly document that the `live` marker is a test value, not a live source record, publication, or authorization. Source rights remain pending and no real content, reviewer data, or permission metadata may be introduced.
- Do not add dependencies, migrations, routes, API/OpenAPI changes, database calls, source/model calls, credentials, or provider configuration. Do not alter the synthetic demo API behavior.

## Allowed paths

- `apps/worker/src/layers/l4-application-integration/public-projection.ts`
- `apps/worker/test/l4-public-projection.test.ts`
- `apps/worker/package.json` — only add the focused test to the existing test command
- This assignment's implementation handoff only

Root owns ADRs, architecture, backlog, public API composition, database view/role changes, and any source-rights decision. If the existing EventView fields cannot be safely constructed from the accepted schema without changing a public contract, report the exact gap before broadening scope.

## Acceptance and checks

- Tests assert exact top-level and nested key sets against the existing OpenAPI `EventView`, `PublicClaim`, `PublicImpact`, and source-attribution shapes.
- Tests prove internal storage fields and adversarial extra fields are absent from serialized output; non-live/withdrawn events, invalid consumed fields, missing or ambiguous attribution/name lookups, and mismatched or missing impact versions fail closed.
- Tests cover multiple sources on one claim, separate source publication/observation times, a no-geometry/non-geographic scope, and stable output ordering without asserting factual quality.
- In WSL Ubuntu-26.04 run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.
- Commit coherent work on the assigned branch with descriptive messages, leave a clean worktree, and append actual changes, checks, limitations and unresolved decisions here. Do not push or merge.

## Implementation handoff

The implementation agent appends the branch/worktree, exact commit SHAs/messages, changed paths, behavior, WSL checks, limitations and any scope issue. Root reviews and accepts before integration.

### Implemented handoff — 25 September 2026

- **Branch/worktree:** `work/API-PROJECT-CORE` at `D:\Projects\RPL\.codex-build\worktrees\api-project-core`.
- **Code commit:** `749869d0804e60847878b057f69132e72990c9e4` — `feat(API-PROJECT-CORE): add public event projection`.
- **Changed paths:** `apps/worker/src/layers/l4-application-integration/public-projection.ts`; `apps/worker/test/l4-public-projection.test.ts`; `apps/worker/package.json` (focused test registration only).
- **Behavior:** Added runtime validation for live, published schema 2.0 event/impact inputs; exact named-scope, public-support attribution, and event/impact-version resolution; deterministic EventView allowlist construction; and bounded typed failures that do not echo input. Unknown storage fields are ignored. Geometry remains outside this projection.
- **Tests:** Authored synthetic/live-shaped values use `.invalid` URLs and fixture-only approval flags. They are not live records, publications, actual source-rights permissions, or reviewer data. Tests compare EventView, PublicClaim, PublicSource, PublicImpact, scope, time, validity, freshness, and tag keys with the existing OpenAPI shapes; cover privacy filtering, multiple source dates, non-geographic audience scope, ordering, invalid/missing/ambiguous lookups, and impact mismatches.
- **WSL checks:** With WSL Ubuntu-26.04 and Node `v24.21.0` / npm `11.19.0` (TypeScript `7.0.2`, tsx `4.23.15`, Wrangler `4.137.0`), `npm test` passed (5 web, 51 Worker, 40 DB, and 12 evaluation tests); `npm run typecheck` passed; `npm run build` passed (typecheck, Vite build, Wrangler dry-run); `git diff --check` and `git diff --cached --check` passed. The Windows-created worktree has a Windows-form `.git` pointer, so WSL Git checks supplied its `GIT_DIR` and `GIT_WORK_TREE` explicitly.
- **Limitations / remaining decisions:** This is pure projection tooling; database reads, route composition, publication authorization, current-version selection, and factual support remain outside this task. Source reuse and excerpt rights remain pending; no real source content or permission metadata was added. No migration, configuration, dependency, or public API/OpenAPI change was made. Root review and acceptance remain outstanding.

### Follow-up — mixed-precision range endpoints — 25 September 2026

- **Code commit:** `f07935462c15af4b5b0e4a38fd946c6725cfea00` — `fix(API-PROJECT-CORE): accept mixed precision ranges`.
- **Changed paths:** `apps/worker/src/layers/l4-application-integration/public-projection.ts`; `apps/worker/test/l4-public-projection.test.ts`.
- **Behavior:** A `range` now validates its start and end independently as either a schema-valid date or date-time, preserves each original value, and compares ordering only when both endpoints have the same precision. Same-type inverted ranges still fail.
- **WSL checks:** On Ubuntu-26.04 with the same Node/npm toolchain, `npm test` passed (5 web, 52 Worker, 40 DB, and 12 evaluation tests); `npm run typecheck` passed; `npm run build` passed; `git diff --check HEAD` and `git diff --cached --check` passed. No schema or public contract changes.
