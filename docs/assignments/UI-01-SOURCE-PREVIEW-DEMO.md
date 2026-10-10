# UI-01-SOURCE-PREVIEW-DEMO

Objective: Bahasa Indonesia source-preview page and strict HTTP client. Dependencies: `docs/DEMO_DATA_INTEGRATION.md`, source-preview-v1. Existing public v1/schema 2.0 unchanged.

Branch `work/UI-01-SOURCE-PREVIEW-DEMO`, worktree `.codex-build/worktrees/ui01-source-preview`. Base: planning commit containing assignment; record SHA. Allowed: `apps/web/src/SourcePreview.tsx`, `apps/web/src/source-preview-client.ts`, `apps/web/src/source-preview.css`, `apps/web/test/source-preview.test.tsx`, this assignment's handoff only. Root handles App navigation, contract package export, tests registration. No packages/global CSS/existing API contracts.

Page interface `SourcePreview({datasetMode, renderMap})` where datasetMode `"demo"|"live"|null`, renderMap callback `(points: readonly PreviewRecord[], selectedId: string|null, onSelect:(id:string)=>void, onReturnToList:()=>void)=>ReactNode`. Map implementation is another package; no direct import. Exact confirmed demo required; otherwise don't fetch. Default loads snapshot endpoint; explicit **Ambil data sumber** fetches `?mode=fetch`; loading disabled; allow restoring snapshot; no interval or automatic live request. Client bounded response bytes + typed runtime validation/allowlisting; validate IDs/source/kind/coordinates/times and fixed permitted source URLs/license to fail closed; AbortController on unmount. Separate sources and statuses snapshot/fetched/empty/unavailable/not requested. Show snapshot dates, source database time vs observations/fetch times, missing time and provider-only status. Facility list/point and citizen report are not incident publication. Display **Pratinjau sumber — belum melalui publikasi Waspada**, non-commercial use, attribution and both license links. Brief L1/L2/L3-skipped/L4/L5 actual-flow strip, no model/RAG claim. Search/filter selection client-side; desktop list/map; mobile list first/map switch; selected details and source links remain usable without map. No reports != safe; no synthetic fallback on source failure. Civic palette/tokens and compact layout from spec. No HTML rendering from source text or danger radius.

Verification WSL Ubuntu-26.04 existing Node v24.21.0 PATH/dependencies: `node --import tsx --test apps/web/test/source-preview.test.tsx`; web typecheck if shared export exists; base diff check. Meaningful tests client schema/malformed payload/unsafe source URLs/response bound and SSR presentational states, independent layer statuses/time labels. Mock network only, no extra dependencies. Root browser QA later. Commit work/handoff; stop and ask root for scope/contract conflicts. No merge/push/deploy/source/provider configuration/further agents.

## Handoff

Record branch/worktree/base, SHAs/exact messages, paths, actual checks/versions, limitations and configuration impact. Root acceptance pending.

Implementation handoff (10 October 2026):

- Branch/worktree: `work/UI-01-SOURCE-PREVIEW-DEMO` at `.codex-build/worktrees/ui01-source-preview`.
- Base: `0270af0c0b0233f467bcf680315f3df49f76a331` (root-approved isolated `source_created_at` DTO refinement; existing public contracts unchanged).
- Code commit: `7c7b65109571f3be9d29930dbc8abedb613aa43d` — `feat(UI-01-SOURCE-PREVIEW-DEMO): add guarded source preview page`.
- Changed implementation paths: `apps/web/src/SourcePreview.tsx`, `apps/web/src/source-preview-client.ts`, `apps/web/src/source-preview.css`, `apps/web/test/source-preview.test.tsx`.
- Behavior: demo-only page defaults to the local snapshot endpoint; source network fetch runs only after explicit user action. The bounded client validates and copies the versioned DTO, source-specific IDs/URLs/licenses/envelopes/times, and rejects oversized or unsafe responses. The UI keeps source state, provider status and report creation time separate from Waspada publication and physical event time; it provides filters, linked selection, a map callback, mobile list/map switch, accessible loading/error/empty states, and source attribution.
- Checks run in WSL Ubuntu-26.04 using Node `v24.21.0`, npm `11.19.0`, existing dependencies: `node --import tsx --test apps/web/test/source-preview.test.tsx` (12/12 passed); `npm run typecheck --workspace=@waspada/web` (passed); `git diff --check HEAD` (passed; only Git's CRLF-to-LF normalization warning).
- Limitations and pending work: mocked HTTP only; no live provider request, integrated browser run, map implementation, or App navigation was tested here. Root owns navigation, main entry CSS imports, package export/test registration, integrated browser QA and acceptance.
- Migration/configuration impact: none; no dependencies or secrets added and no configuration/database migration required.
- Remaining decision: root review and acceptance after integrated browser QA.

Root review follow-up (10 October 2026):

- Code commit: `d7007f56a8988b3cd7f8a8577e3dd7b111755f9e` — `fix(UI-01-SOURCE-PREVIEW-DEMO): bound requests and retry snapshots`.
- Added a **Coba muat snapshot** action after initial snapshot failure. The browser client now races the fixed endpoint request and streamed body against a 35-second deadline, aborts its internal request on timeout or external/unmount cancellation, and does not await stream cancellation when rejecting an oversized response. Tests use an injected clock and mocked fetch/body streams.
- Source timestamps now distinguish successful data acquisition from an unavailable request attempt: successful/empty responses say **Data diambil pada**; unavailable responses say **Permintaan dicoba pada**.
- Follow-up checks: WSL Ubuntu-26.04, Node `v24.21.0`, npm `11.19.0`, existing dependencies; focused tests (15/15 passed) and web typecheck (passed). Base-to-HEAD diff check is recorded after the final handoff commit.

Worker-parity and desktop-layout follow-up (10 October 2026):

- Branch/worktree: `work/UI-01-SOURCE-PREVIEW-DEMO` at `.codex-build/worktrees/ui01-source-preview`; approved base remains `0270af0c0b0233f467bcf680315f3df49f76a331`.
- Code commit: `8690062ad354e1300bea35ec87656a0dcbffdeec` — `fix(UI-01-SOURCE-PREVIEW-DEMO): align client with worker DTO`.
- Changed paths: `apps/web/src/SourcePreview.tsx`, `apps/web/src/source-preview-client.ts`, `apps/web/src/source-preview.css`, `apps/web/test/source-preview.test.tsx`.
- The browser validator now follows the Worker endpoint's source-mode/status rules, timestamp bounds, cached-response semantics, duplicate-ID rejection, source-specific coordinate kinds, PetaBencana creation-time requirement, and rejected-record limit. Regression cases cover invalid mode/status combinations, unavailable attempts, cached snapshots, future timestamps, wrong coordinate kinds, missing PetaBencana creation times, and a valid OSM way.
- The desktop intro is shorter and smaller; source cards no longer repeat the source name or the generated response timestamp already shown in the summary. Unrequested sources retain their explicit “Belum diminta” state without empty timestamp rows. Mobile list-first behavior and distinct acquisition, provider-update, and physical-event time explanations remain intact.
- Checks run in WSL Ubuntu-26.04 using Node `v24.21.0`, npm `11.19.0`, and existing dependencies: `node --import tsx --test apps/web/test/source-preview.test.tsx` (17/17 passed); `npm run typecheck --workspace=@waspada/web` (passed); `git diff --check` (passed; Git reports the existing CRLF-to-LF normalization notice for the test file).
- Limitations/configuration: no live provider request, browser screenshot rerun, dependencies, secrets, configuration changes, or migrations. Root owns integrated browser QA and acceptance.
