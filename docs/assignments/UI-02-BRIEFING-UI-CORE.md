# UI-02-BRIEFING-UI-CORE — show user-requested live briefings

- **Backlog ID:** `UI-02-BRIEFING-UI-CORE`
- **Objective:** Connect the accepted browser-local interest editor to the exact-live briefing route and display complete, explainable results in the existing civic UI.
- **Dependencies:** `API-PUBLIC-BRIEFING-RUNTIME-CORE`, `API-BRIEFING-PROJECTION-CORE`, `UI-02-LOCAL-PREFERENCES-CORE`, `UI-00`, `UI-API-DETAIL-HISTORY-CORE`, `SPEC-03`, `ADR-025`.
- **Branch/worktree:** `work/UI-02-BRIEFING-UI-CORE` in a free managed worktree based on the next pushed `main`; root prepares the checkout before implementation. Do not edit through the root checkout.
- **Contract baseline:** Existing `BriefingRequest`, `BriefingResponse`, and `BriefingItem` in `docs/api/openapi.yaml`; exact-live route behavior in [API-PUBLIC-BRIEFING-RUNTIME-CORE](API-PUBLIC-BRIEFING-RUNTIME-CORE.md); product flow in [UX/API spec section 3](../UX_API_SPEC.md#3-preferences-briefing-and-in-site-updates). Do not alter API or contract behavior.
- **Allowed paths:** `apps/web/src/App.tsx`, `apps/web/src/Preferences.tsx`, `apps/web/src/api-client.ts`, `apps/web/src/BriefingResults.tsx` (optional new component), `apps/web/src/styles.css`, `apps/web/test/api-client.test.ts`, `apps/web/test/preferences.test.tsx`, `apps/web/test/ui.test.tsx`, and this assignment's handoff section. `apps/web/package.json` only if needed to register an existing test file.
- **Prohibited scope:** OpenAPI/DTO or Worker/backend changes, update polling/feed, account identity, persistent server preferences, source/model calls, inferred relevance, synthetic fixture matching, new dependencies, deployment/binding changes, external services, live data, and migrations.

## Required behavior

1. Add a client for the existing `POST /api/v1/briefings` contract. Send only the current bounded interest object as JSON, with no identity, device location, query-string interests, or unrelated browser data. Do not persist interests or briefing results on the server.
2. Do not send interests on page load, preference editing, or local save. Send them only after an explicit user action. If there are no effective interests, show a local prompt to choose interests and make no request.
3. Render or enable the briefing request only when the already fetched server `PublicContext.dataset_mode` is exactly `live`. In demo or unknown mode, show a clear status explaining why a live briefing is unavailable and make no request. Never run local matching against demo fixtures.
4. Display the response only as current published live items. Show each fixed relevance reason from the server, a safe link to the corresponding existing API event detail, category, lifecycle, freshness, reported event time, and publication time as distinct values. A match is relevance to selected interests, not a safety or urgency verdict. Do not show old versions or withdrawn history.
5. Provide accessible idle, loading, matched, no-match, and generic unavailable/error states. The no-match copy must say **“Belum ada informasi terbit yang cocok dengan minat Anda.”** and must not imply that an area is safe. A route/API failure keeps local interests available and never displays a partial result.
6. Clear or invalidate displayed results when interests change or dataset mode ceases to be exact live; ignore a late response for an obsolete interest/mode snapshot. Do not echo preference values into telemetry, logs, error text, or URLs.
7. Keep the existing local privacy disclosure accurate: explain that interests stay in this browser and are transmitted only for the explicitly requested briefing, are not saved by the service, and are removed if browser data is cleared.
8. Do not implement the update centre in this task. Keep update polling, deduplication of material changes, and push notifications as separate future work.

## Verification

Use existing package dependencies only. Run focused web/API-client and preferences tests, full `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` in WSL Ubuntu-26.04. Record runtime/package versions. Tests must prove the explicit-send boundary, exact-live mode gate, no demo/unknown/empty-interest request, request method/content-type/body, privacy behavior, and all UI response states, including stale-response suppression and separate lifecycle/freshness/time fields. Use mocked `fetch` and authored fictional response fixtures; do not use a live service. If existing headless browser tooling is installed, inspect desktop/mobile screenshots; do not install browser tooling or use desktop-control automation. Report if visual screenshots could not be captured.

## Stop conditions

Stop if the current API response cannot be rendered without changing its contract, if a safe detail link cannot be expressed using the existing route, or if live/demo selection cannot be taken from the server-reported context. Do not add local matching or synthetic fallback. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt encounters a substantive technical difficulty it cannot resolve; usage limits or scheduling delays do not qualify.

## Implementation handoff

Append branch/worktree, exact commit SHA(s) and messages, changed paths, behavior, actual checks/results, runtime versions, limitations, visual-review result, configuration impact, and remaining decisions. Commit on the assigned branch; do not merge or push. Root independently reviews and integrates.

### Completed implementation handoff

- **Branch/worktree:** `work/UI-02-BRIEFING-UI-CORE` at `/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL`, based on `13b3e3abd1782398a2dc24b5e89abfb1a9a44dba`.
- **Implementation commit:** `bf249e86bc681808d8503ca3f40a4129efb14196` — `feat(web): add explicit live briefings`.
- **Changed paths:** `apps/web/src/App.tsx`, `apps/web/src/Preferences.tsx`, `apps/web/src/BriefingResults.tsx`, `apps/web/src/api-client.ts`, `apps/web/src/styles.css`, `apps/web/test/api-client.test.ts`, `apps/web/test/preferences.test.tsx`, and `apps/web/test/ui.test.tsx`.
- **Behavior:** Preferences now receives the server `PublicContext` for its active route and keeps briefing controls unavailable until exact `live` is confirmed. A user must explicitly request a briefing, and the client sends only normalized interests in the existing JSON `POST /api/v1/briefings` body. Demo, unknown, and empty-interest states make no request. Results render server reasons, an encoded link to current API detail, category, lifecycle, freshness, event time and publication time separately. Interest/context snapshots invalidate old results and suppress late responses. Errors stay generic and leave local interests available. No update polling or local/demo matching was added.
- **Checks:** `npm test --workspace=@waspada/web` passed 41/41 after the final client change. Full `npm test` passed: web 41, Worker 251, DB 19/19 test files, evaluation 12. Root `npm run typecheck` passed. Root `npm run build` passed, including Vite production build and Wrangler dry run. `git diff --check` exited 0; Git printed only CRLF-to-LF normalization warnings for existing Windows-format files.
- **Runtime/packages:** WSL Ubuntu-26.04; Node.js `v24.21.0`; npm `11.19.0`; React and React DOM `19.3.0`; Vite `8.3.0`; Wrangler `4.137.0`.
- **Limitations and visual review:** No browser screenshots were captured because this task was explicitly run without browser/UI automation while the user was using the computer. No live service or live data was used. The current checked-in Worker remains demo-only without a Hyperdrive binding, so the live briefing remains unavailable until the existing server context reports exact `live` and the existing route is configured.
- **Migration/configuration impact:** None. No dependency, lockfile, API/DTO, Worker, binding, source, data, or migration changes.
- **Remaining decisions:** None within this assigned UI slice. At this handoff, the update centre remained future work; it was subsequently implemented under [UI-02-UPDATE-CENTER-CORE](UI-02-UPDATE-CENTER-CORE.md).
