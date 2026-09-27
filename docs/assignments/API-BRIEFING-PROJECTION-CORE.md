# API-BRIEFING-PROJECTION-CORE — deterministically match published information to local interests

- **Backlog ID:** `API-BRIEFING-PROJECTION-CORE`
- **Objective:** Implement a pure, bounded Layer 4 projection from exact-match user interests and already projected public events to the existing briefing response contract.
- **Dependencies:** `API-PUBLIC-EVENT-LIST-RUNTIME-CORE`, `API-PUBLIC-CONTEXT-RUNTIME-CORE`, `API-PROJECT-CORE`, `UI-02-LOCAL-PREFERENCES-CORE`, `SPEC-03`.
- **Branch/worktree:** `work/API-BRIEFING-PROJECTION-CORE` in a free managed worktree based on pushed `main`; root will identify and prepare the checkout before implementation. Do not edit through the root checkout.
- **Contract baseline:** Existing OpenAPI 3.1 `BriefingRequest`, `BriefingResponse`, `BriefingItem`, and `EventView` in `docs/api/openapi.yaml`; existing preference shape in `apps/web/src/preferences-store.ts`. TypeScript types may be added to mirror these exact schemas. Do not change OpenAPI, request/response fields, bounds, route behavior, or UI behavior.
- **Allowed paths:** `apps/worker/src/contracts/public-api.ts`, `apps/worker/src/layers/l4-application-integration/public-briefing-projection.ts`, `apps/worker/test/l4-public-briefing-projection.test.ts`, `apps/worker/package.json` only if required to register a focused test, and this assignment's handoff section.
- **Prohibited scope:** HTTP route, SQL, database/repositories, source acquisition, persistence, account identity, model/API calls, embeddings, vector retrieval, semantic/fuzzy matching, ranking/scoring, synthetic/demo relevance, UI changes, dependencies, migrations, deployment/bindings, OpenAPI changes, or live data.

## Context and design decision

The local preference editor already stores bounded arrays for places, services, institutions, audiences, and event categories. OpenAPI defines a transient `POST /briefings` request and a bounded response containing unchanged `EventView`s with one or more explanation strings. The event list and context contracts now support exact-live execution, although the checked-in Worker remains configured for demo mode.

Use deterministic case-insensitive **exact** matching on trimmed Indonesian locale text (`toLocaleLowerCase("id")`) for the four scope-name dimensions, and exact enum equality for categories. Match a text interest against the union of the corresponding public scope names on the event, its published claims, and its published impacts. A category matches the event's category. Do not search title, summary, claims' prose, tags, URLs, or private/internal identifiers. Do not use substring similarity, geographic proximity, lifecycle/freshness as a rank/filter, embeddings, or model inference.

The projector must accept only an exact server-selected `live` mode and already Layer-4-projected `EventView`s. It cannot transform demo, historical, unknown-mode, or malformed inputs into a briefing. The caller supplies a bounded event page and its server-generated ISO `generated_at`; no persistence or network operation occurs here.

For matched records, preserve the input order and every `EventView` field unchanged. Return a fixed, deduplicated Bahasa Indonesia reason for each matched dimension, without echoing any user-provided interest value. Suggested stable reasons are:

- `Sesuai kategori yang Anda ikuti`
- `Mencakup tempat yang Anda ikuti`
- `Mencakup layanan yang Anda ikuti`
- `Mencakup instansi yang Anda ikuti`
- `Mencakup kelompok yang Anda ikuti`

An event may have multiple reasons when multiple dimensions match. A no-match result is an empty `items` array; it must not imply that the area or user is safe. Preserve lifecycle, freshness, event/validity times, evidence, and public version as supplied; matching does not imply that an event is current or relevant to a specific physical location.

## Acceptance criteria

1. Add TypeScript request/response types that mirror the existing OpenAPI shapes without changing the OpenAPI file. Runtime validation rejects malformed/oversized closed interest payloads and a non-live dataset mode with stable non-sensitive errors.
2. Match only exact categories and exact normalized names from event, claim, and impact public scopes. Text comparison is trim-and-case-insensitive for Indonesian locale, not substring/fuzzy matching; category comparison remains exact.
3. Keep input event order, preserve `EventView` values and status/time fields, and return no event when there is no exact match. Empty interests yield an empty response.
4. Reasons are fixed strings per matching dimension, stable in order, deduplicated, bounded by the existing response schema, and contain none of the user's preference strings.
5. Reject an event page above the existing 100-item response bound, duplicate event IDs, malformed projected inputs, and an invalid generated timestamp rather than truncating, ranking, or returning a partial response.
6. No model, database, route, source provider, persistence, user identity, network access, or external service is used or initialized.
7. Focused tests cover exact/mixed-case matching, all five dimensions, scope on event/claim/impact, non-substring misses, multiple reasons, no matches/empty interests, preservation of input order and event status, demo/non-live rejection, duplicate/overflow/malformed rejection, timestamp validation, output allowlists/bounds, and absence of preference-string echo.

## Verification

Use WSL Ubuntu-26.04. Record exact runtime versions before changes. Run:

```sh
npm exec --workspace=@waspada/worker -- tsx --test test/l4-public-briefing-projection.test.ts
npm test --workspace=@waspada/worker
npm run typecheck
npm run build
git diff --check
```

Register the focused test in the Worker test script so the aggregate workspace suite also runs it. Do not install dependencies just to run tests. Use authored fictional fixture values only; they do not establish factual relevance or live-data accuracy.

## Stop conditions

Stop and report the precise gap if implementation requires an OpenAPI/request/response shape change, database/source/model access, preference persistence, or interpreting an event as current/safe based on relevance. Do not expand this slice to the briefing route or browser UI. Escalate to GPT-6 Astra xhigh only if a GPT-6 Luna Max attempt encounters a substantive technical difficulty and still cannot resolve it; usage limits or scheduling delays do not qualify.

## Implementation handoff

### Branch and implementation commit

- Branch: `work/API-BRIEFING-PROJECTION-CORE`
- Worktree: `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL` in WSL Ubuntu-26.04)
- Implementation commit: `f03fbc17bf40dfd336f1cbf7009132cfba37355b` — `feat(API-BRIEFING-PROJECTION-CORE): add exact-live briefing projection`
- Handoff commit message: `docs(API-BRIEFING-PROJECTION-CORE): record implementation handoff`

### Changed paths and behavior

- `apps/worker/src/contracts/public-api.ts` adds TypeScript `BriefingRequest`, `BriefingInterests`, `BriefingItem`, and `BriefingResponse` types matching the existing closed OpenAPI shapes.
- `apps/worker/src/layers/l4-application-integration/public-briefing-projection.ts` adds a pure Layer 4 projector that accepts only exact `live` mode, validates the closed interest request and projected event inputs, and applies case-insensitive exact matching after NFC normalization, trimming, and `toLocaleLowerCase("id")`. Categories compare by exact enum value. Scope names are read only from event, published claim, and published impact scopes. The projector preserves event order and returns each original `EventView` unchanged with at most one fixed Indonesian reason per matched dimension. It rejects malformed requests/events, invalid timestamps, duplicate event IDs, and pages over 100 items with stable generic errors.
- `apps/worker/test/l4-public-briefing-projection.test.ts` covers all five dimensions, event/claim/impact scope matching, exact and mixed-case behavior, substring misses, deduplicated reasons, empty/no matches, preserved order/status/object identity, non-live modes, malformed/oversized inputs, duplicates, timestamps, response allowlists/bounds, and fixed reasons without interest-text interpolation. Fixtures are authored fictional values only.
- `apps/worker/package.json` registers the focused test in the Worker suite.
- This assignment file records the handoff.

No briefing route, preference persistence, history read, or withdrawn-version read was added. The projector trusts its caller to provide exact-live, current-public `EventView`s from the existing L4 event projection; the `EventView` contract does not carry withdrawal state, so upstream current-public selection remains responsible for keeping a withdrawn latest version and its public history hidden.

### Checks and runtime versions

All checks ran in WSL Ubuntu 26.04 LTS using Node `v24.21.0` and npm `11.19.0`; the local tools were tsx `v4.23.15`, TypeScript `7.0.2`, and Wrangler `4.137.0`. No dependency was installed.

- `npm exec --workspace=@waspada/worker -- tsx --test test/l4-public-briefing-projection.test.ts` — passed, 10 tests.
- `npm test --workspace=@waspada/worker` — passed, 234 tests.
- `npm run typecheck` — passed for web, Worker, DB, and evaluation TypeScript projects.
- `npm run build` — passed; Vite production build and Wrangler Worker dry-run completed.
- `git --git-dir=/mnt/d/Projects/RPL/.git/worktrees/RPL1 --work-tree=/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL diff --check` and the corresponding `diff --cached --check` — passed with no whitespace errors.

### Limitations and remaining decisions

- This slice is not connected to an HTTP route or browser UI. It accepts only the supplied projected page and caller-generated timestamp; it performs no network, database, model, source-provider, or persistence work.
- No migration, runtime configuration, binding, or dependency change is required. The package script change only registers the focused test.
- No design decision remains for this core. Route integration remains outside this assignment and must continue to supply current-public exact-live event projections.

The root orchestrator reviews and accepts this work independently.
