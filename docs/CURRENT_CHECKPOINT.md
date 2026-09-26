# Waspada Jakarta — Current Checkpoint

**Checkpoint date:** 26 September 2026
**Reason:** Root accepted UI-02-LOCAL-PREFERENCES-CORE on local `main` at handoff `b469a02` (implementation `be4c34d`) after reviewing the branch, independently passing focused tests 20/20 and the full workspace suite 241/241, and passing typecheck, build, and WSL diff checks. Root reviewed headless desktop and mobile screenshots; measured viewport widths showed no overflow. The browser-local interest editor is accepted, while briefing/update matching remains unimplemented. Root recorded the user-selected application GeoJSON query envelope in ADR-018 and OpenAPI, assigned its synthetic route, and pushed the documentation checkpoint to `origin/main` at `6700df7`. The implementation branch is ready at that checkpoint. The prior accidental OpenAPI edit was restored from `main` before this separately documented contract clarification. Source/data rights, human labels, model/provider selection, moderator authorization, hosted Neon behavior, and complete runtime integration remain gated.
**Repository:** `D:\Projects\RPL`
**Remote:** `origin` → `https://github.com/Asassinoooo/Waspada-Jakarta.git`

## Repository state

The latest accepted task is UI-02-LOCAL-PREFERENCES-CORE at handoff `b469a02` (`be4c34d` implementation), fast-forwarded to local `main`. Root's documentation checkpoint is pushed to `origin/main` at `6700df7`. The public `#ringkasan-saya` route stores bounded interests in browser local storage, exposes explicit save/clear, handles malformed or unavailable storage, and makes no network, relevance, or safety claims. Root independently passed focused web tests 20/20, `npm test` 241/241 (web 20, Worker 131, DB 78 across 10 isolated files, casebook 12), typecheck, Vite/Wrangler build, and WSL diff checks. Root inspected headless screenshots at desktop 1440×900 and mobile 390×844; the agent measured 390px and 320px layouts without horizontal overflow. No server, database, dependency, migration, or external resource changed. Briefings and updates remain unimplemented.

ADR-018 records the inclusive CRS84 application query envelope `west=106.32, south=-6.40, east=106.98, north=-5.16`, outward-rounded from the Jakarta 2025–2029 regional-plan extents. It limits the GeoJSON request only; it is not an administrative boundary, event geometry, or warning area. The OpenAPI bbox description now records it. `work/API-GEOJSON-ROUTE-CORE` is prepared in `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL` at base `6700df7`; the implementation is pending. No live DB reader or source-supported event geometry is wired.

Local `main` includes root-reviewed GEO-STORE-CORE at merge `3207800`, L1-WRITE-IDEMPOTENCY-CORE at merge `59e59e8`, L1-FIXTURE-PIPE-CORE at merge `e5b1647`, EVAL-01-TOOLS at merge `9f80600`, API-PROJECT-CORE at integration commits `c383faa` and `249c5e2`, PUB-WRITE-CORE at merge `b2fb994`, L3-LEDGER-CORE at implementation `ed0f307` plus handoff `32d4678`, DB-TEST-RUNNER-ISOLATION at handoff `805ccd4`, L2-CONTEXT-PERSIST-CORE at merge `6effd54`, L2-CONTEXT-BRIDGE-CORE at merge `6ced3ea`, OBS-01-API-TELEMETRY-CORE at integration `8135a90`, OBS-01-L2-RETRIEVAL-TELEMETRY-CORE at integration `12509e3`, OBS-01-L3-LEDGER-TELEMETRY-CORE at integration `408de10`, RAG-CONTEXT-ASSEMBLY-CORE at handoff `f4ca0dc`, L2-DIRECT-REASONING-CORE at handoff `c3e2005`, L3-SINGLE-STEP-EXECUTOR-CORE at handoff `22b1f10` with root acceptance `d8a5b62`, API-GEOMETRY-CORE at handoff `c0d6ade`, API-DETAIL-HISTORY-ROUTES-CORE at handoff `48c7f73`, UI-API-DETAIL-HISTORY-CORE at handoff `e53caf5`, and UI-02-LOCAL-PREFERENCES-CORE at handoff `b469a02`. The accepted project work includes BOOT-01, UI-00, UI-API-DETAIL-HISTORY-CORE, UI-02-LOCAL-PREFERENCES-CORE, PLATFORM-01, DATA-01, ING-PARSE-01, L2-ADAPTER-01, JOB-01, DATA-02-CORE, GEO-STORE-CORE, L1-WRITE-IDEMPOTENCY-CORE, L1-FIXTURE-PIPE-CORE, RAG-CORE, RAG-ACCESS-01, L2-CONTEXT-PERSIST-CORE, L2-CONTEXT-BRIDGE-CORE, RAG-CONTEXT-ASSEMBLY-CORE, L2-DIRECT-REASONING-CORE, L3-INSUFFICIENT-CONTEXT-ENTRY-CORE, L3-SINGLE-STEP-EXECUTOR-CORE, API-GEOMETRY-CORE, API-DETAIL-HISTORY-ROUTES-CORE, PUB-POLICY-CORE, API-PROJECT-CORE, PUB-WRITE-CORE, L3-LEDGER-CORE, OBS-01-API-TELEMETRY-CORE, OBS-01-L2-RETRIEVAL-TELEMETRY-CORE, OBS-01-L3-LEDGER-TELEMETRY-CORE, DB-TEST-RUNNER-ISOLATION, and the synthetic-only casebook contract/validator. EVAL-01 real case collection remains planned because source/data rights are pending. Perry Tjahya and Jesaya Hamonangan Gaudensius Malau are identified as future independent reviewers; no human labels were created. Implemented fixtures remain synthetic, and historical/synthetic datasets cannot receive publishable policy dispositions.

## Latest work and files

### UI-02-LOCAL-PREFERENCES-CORE — accepted

Root accepted the browser-local preferences editor on local `main` at handoff `b469a020dab12182886d6939efb768d4ddc64bc0`, from implementation `be4c34dd762fcb6b0f757b7e0ceb0204881c4934`. It adds the `#ringkasan-saya` view and validates, saves, and clears versioned browser-only interests in the five existing briefing dimensions. Storage errors are visible and recoverable. No server communication or synthetic event matching was added; briefings and updates remain disconnected.

The implementer and root passed focused web tests (20/20). Root independently passed the full WSL suite (241/241: web 20, Worker 131, DB 78, casebook 12), `npm run typecheck`, `npm run build` (Vite production build and Wrangler dry-run), and `git diff --check`. Root reviewed headless screenshots at 1440×900 and 390×844. The mobile page had no horizontal overflow; agent metrics also confirmed no overflow at 320×844. No migration, contract, dependency, server, configuration, or external resource changed. See the [assignment and handoff](assignments/UI-02-LOCAL-PREFERENCES-CORE.md).

### UI-API-DETAIL-HISTORY-CORE — accepted

Root reviewed and fast-forwarded `work/UI-API-DETAIL-HISTORY-CORE` to local `main` at handoff `e53caf5` (`113e032d2b39f088dfcf3edb1c2b9630395c4d4` implementation; `e53caf5b5220d35f0eb52b198485210918e51e24` handoff). The API detail route now fetches typed `EventDetail` and `HistoryPage` data independently, with encoded IDs, per-request loading/unavailable/not-found states and retry. Cancellation and event-ID keys prevent an old request from rendering over a new route. Empty evidence/history stay explicitly unavailable; the demo label and no-geometry fallback remain. The [assignment](assignments/UI-API-DETAIL-HISTORY-CORE.md) and [delivery log](DELIVERY_LOG.md) record the handoff and boundaries.

The agent and root independently passed focused web/API tests 9/9. Full WSL `npm test` passed 230 tests (web 9, Worker 131, DB 78 across 10 isolated files, casebook 12); typecheck, Vite/Wrangler build and diff checks passed. The agent reviewed desktop 1440×900 and mobile 390×844 screenshots; the mobile page had no horizontal overflow. The UI reads only synthetic routes. No API/OpenAPI contract, CSS, database reader, GeoJSON endpoint, live source, dependency, migration, external service or deployment changed.

### API-DETAIL-HISTORY-ROUTES-CORE — accepted

Root reviewed and fast-forwarded `work/API-DETAIL-HISTORY-ROUTES-CORE` to `main` at handoff `48c7f73` (`c66bdc140a7365556e6173e1644c0a3e06267f97` implementation; `48c7f736b203f12caac854db0fe75d25c6bc9f00` handoff). The existing GET detail/history routes now serialize only the two explicit synthetic fixtures. Detail copies the known EventView fields and adds `geometries: []`; history returns one fixture-version entry with its existing publication timestamp and a synthetic-only summary. Both return safe errors, validate IDs and bounded history pagination, reject writes, and keep telemetry to the fixed `events` route category. Explicit non-demo mode returns 503 before fixture access. The [assignment](assignments/API-DETAIL-HISTORY-ROUTES-CORE.md) documents the boundary.

The agent and root each passed focused API tests 13/13, full `npm test` 226/226 (web 5, Worker 131, DB 78 across 10 isolated files, casebook 12), `npm run typecheck`, `npm run build` (Vite production build and Wrangler `4.137.0` dry-run), and WSL diff checks. Tests use only authored fictional fixtures. No database or source read, GeoJSON route, publication authorization, OpenAPI change, dependency, migration, binding, external service, or deployment was added. Hosted DB behavior and live source reuse/factual quality remain unverified. The temporary dependency link was removed before commit.

### API-GEOMETRY-CORE — accepted

Root reviewed and fast-forwarded `work/API-GEOMETRY-CORE` to `main` at handoff `c0d6ade` (`ac30df25d989a79219fa098a4e5f2e8073b24e8b` implementation; `c0d6ade73375c6d0b0ea94d0e2c55cc68462f860` handoff). The pure L4 projector emits only geometries referenced by a live-shaped published event and claim, with an exact matching `supports` evidence span. It validates CRS84 role-compatible 2D coordinates and bounded GeoJSON, then constructs strict public `EventDetail` and FeatureCollection allowlists. It does not transform or infer geometry, read the database, or serve HTTP. The [assignment](assignments/API-GEOMETRY-CORE.md) and [handoff](assignments/API-GEOMETRY-CORE-HANDOFF.md) define the boundary.

Root independently ran WSL Ubuntu-26.04 with Node.js `v24.21.0` and npm `11.19.0`: focused projection tests passed 8/8; `npm test` passed 220/220 (web 5, Worker 125, DB 78 across 10 isolated files, evaluation 12); `npm run typecheck`, `npm run build` (Vite production build and Wrangler `4.137.0` dry-run), and `git diff main...HEAD --check` passed. Tests are synthetic structural checks and do not prove factual support, source rights, DB reads, or route behavior. No API/OpenAPI contract, dependency, migration, external service, or deployment changed.

### L3-SINGLE-STEP-EXECUTOR-CORE — accepted

Root reviewed and fast-forwarded `work/L3-SINGLE-STEP-EXECUTOR-CORE` to `main` at handoff `22b1f10` (`4d52744` initial implementation, `6543d16` replay-precedence fix, `35f049b` aggregate-input bound). The executor validates a strict proposal against an injected registry, lets `reserveAction` resolve exact reservation identity before returning typed stale/closed/in-flight review outcomes, and invokes a single handler only when `startAction` grants authorization. It reconciles one closed bounded receipt, enforces a 32,768-code-unit aggregate input ceiling and 128-code-unit object-key cap, and preserves unknown ledger errors unchanged. No action is registered in runtime; no model planner, live tool/source, route or publication path was added. The final task handoff is [here](assignments/L3-SINGLE-STEP-EXECUTOR-CORE-HANDOFF.md).

Root independently ran WSL Ubuntu-26.04 with Node.js `v24.21.0` and npm `11.19.0`: focused executor tests passed 16/16; `npm test` passed 212/212 (web 5, Worker 117, DB 78 across 10 isolated test files, casebook 12); `npm run typecheck`, `npm run build` (Vite and Wrangler `4.137.0` dry-run), and `git diff main...HEAD --check` passed. The tests use a fake ledger and synthetic action; hosted DB concurrency and Worker/database wiring remain unverified. No dependency, migration, contract, provider, cloud resource or deployment changed.

### L3-INSUFFICIENT-CONTEXT-ENTRY-CORE — accepted

Root reviewed and fast-forwarded `work/L3-INSUFFICIENT-CONTEXT-ENTRY-CORE` to `main` at handoff `c8c16c5` (`9bf5407` implementation). The entry service maps only the typed persisted insufficient-context outcome to the existing ledger, derives bounded `missing_field_N` / `conflict_N` labels, and sends ambiguous event matches or invalid question counts to review. No planner, tool, model, source, route or runtime wiring was added. Root independently passed the focused test 8/8, full suite 196/196 (web 5, Worker 101, DB 78, evaluation 12), typecheck, Vite/Wrangler dry-run build, and WSL diff check. Hosted PostgreSQL/Neon and application/database composition remain unverified; see the [assignment](assignments/L3-INSUFFICIENT-CONTEXT-ENTRY-CORE.md), [handoff](assignments/L3-INSUFFICIENT-CONTEXT-ENTRY-CORE-HANDOFF.md), and [delivery record](DELIVERY_LOG.md).

### OBS-01-API-TELEMETRY-CORE — accepted

Root reviewed and fast-forwarded the dedicated branch to `main` at `8135a90`. The implementation commit is `6987324` (`feat(OBS-01-API-TELEMETRY-CORE): add safe sampled API telemetry`); the separate handoff commit is `8135a90` (`docs(OBS-01-API-TELEMETRY-CORE): record implementation handoff`). The L4 API handler records exactly one fixed event name, route category, HTTP response status and finite non-negative duration through an injected L5 sink; a throwing sink cannot alter its response. The Worker entry point uses an allowlisted structured console logger. Wrangler enables 1% sampling and disables invocation URL logs. The assignment, handoff and Cloudflare Free log limits are documented locally. No API/OpenAPI contract, dependency, migration, database wiring, source, or model changed, and no deployment or external account operation occurred.

Root independently ran WSL Ubuntu-26.04 with Node.js `v24.21.0` and npm `11.19.0`: `npm test` passed 163/163 (web 5, Worker 69, DB 77, evaluation 12); `npm run typecheck`, `npm run build` (Vite production build and Wrangler 4.137.0 dry-run), and `git diff --check` passed. The dry-run validates the Wrangler settings only; actual Cloudflare Workers Logs collection has not been remotely verified. This slice supplies API request telemetry, not the full quality, cost, source-health and evaluation monitoring in OBS-01.

### OBS-01-L2-RETRIEVAL-TELEMETRY-CORE — accepted

Root reviewed and fast-forwarded `work/OBS-01-L2-RETRIEVAL-TELEMETRY-CORE` to `main` at handoff `12509e3`. Implementation commit `4850da0` adds a closed success/error telemetry union and instruments the Layer 2 read-only evidence retriever through an injected sink. Success records contain only duration, candidate/row counts, truncation flags and a closed semantic status; error records omit exception details. The sink defaults to no-op. Retrieval query, result and repository error semantics remain unchanged; sink failures cannot mask success or the original error. Handoff: [OBS-01-L2-RETRIEVAL-TELEMETRY-CORE-HANDOFF.md](assignments/OBS-01-L2-RETRIEVAL-TELEMETRY-CORE-HANDOFF.md).

The implementer passed focused retrieval/API tests (11/11), typecheck, build and diff checks. Root independently ran WSL Ubuntu-26.04 with Node.js `v24.21.0` and npm `11.19.0`: `npm test` passed 166/166 (web 5, Worker 72, DB 77 across 10 files, evaluation 12); `npm run typecheck`, `npm run build` (Vite and Wrangler 4.137.0 dry-run), and `git diff d888d92..HEAD --check` passed. There is no current Worker/database composition path injecting the console sink, so this does not establish remote telemetry collection, retrieval quality or model behavior. No API contract, SQL, schema, migration, dependency, external account, or deployment changed.

### OBS-01-L3-LEDGER-TELEMETRY-CORE — accepted

Root reviewed the dedicated branch and integrated it on `main` at handoff `408de10` (`e6f3956` implementation). The Worker-side decorator reports only closed write-operation/outcome data, duration, lifecycle/stop reason and consumed budget counters; it omits case/action/source/model identifiers and exception details, leaves reads uninstrumented, and preserves the exact repository result or error. The sink defaults to no-op and fails open. Focused tests passed 17/17, and root independently passed the full 172-test WSL suite, typecheck, build and diff checks. No coordinator, DB runtime composition, source/model integration, route, deployment or remote collection was added. See [assignment](assignments/OBS-01-L3-LEDGER-TELEMETRY-CORE.md) and [handoff](assignments/OBS-01-L3-LEDGER-TELEMETRY-CORE-HANDOFF.md).

### L2-CONTEXT-BRIDGE-CORE — accepted

Root reviewed and merged `work/L2-CONTEXT-BRIDGE-CORE` at `6ced3ea`. Implementation commit `4cebaa2` adds a pure injected adapter that validates unknown input with `validateReasoningRequest`, maps all canonical schema 2.0 fields into the refs-only `GroundingContextRecord`, invokes `createOrVerify` once, and returns both the validated expanded request and the persisted record. Excerpt text, source metadata, timestamps and origin lineage remain only in memory; the supplied `sufficient` value is preserved without interpretation. Four synthetic Worker tests cover the full projection, all four relations, input immutability, validation-before-write and exact error propagation. Handoff `32b4460` records the commands and limitations.

Root independently ran the focused bridge test (4/4), `npm test` (160/160: web 5, Worker 66, DB 77, casebook 12), `npm run typecheck`, `npm run build` (Vite and Wrangler dry-run), and WSL `git diff --check`. No dependency, lockfile, migration, contract, Worker route, hosted database wiring, model/provider integration or publication behavior changed. The writer still depends on database records already existing, and PGlite/hosted Neon behavior remains limited as documented in the persistence handoff.


### L3-LEDGER-CORE — accepted

Root reviewed and fast-forwarded `work/L3-LEDGER-CORE` to `main` at handoff `32d4678` (`ed0f307` implementation, `32d4678` handoff). Migration 008 and the typed repository persist cases only from insufficient L2 contexts, support same-candidate context refresh, reserve budgets before actions, reconcile retries/interruption idempotently, and append schema 2.0 checkpoint snapshots under a narrow `NOLOGIN` role. Six synthetic PGlite behavior tests and eight migration/role tests pass; root independently reran both suites in WSL. At that acceptance point the aggregate runner issue was reproducible; DB-TEST-RUNNER-ISOLATION has since added the sequential per-file launcher, with all final aggregate checks passing.

### GEO-STORE-CORE — accepted

Root reviewed and merged `work/GEO-STORE-CORE-source-backed-geometry` at `3207800` from `40f1572` (`feat(GEO-STORE-CORE): persist source-backed geometry`) and `dc73384` (`docs(GEO-STORE-CORE): record implementation handoff`). It adds `apps/db/src/geometry-writer.ts`, synthetic PGlite cases, migration 006 and the updated migration privilege tests. The transactional writer validates schema 2.0 Geometry fields, CRS84 coordinates, role/type compatibility and PostGIS topology; verifies each support reference against exactly one same-dataset immutable text revision and Unicode span; and stores the submitted shape and links atomically. Replays compare typed columns, EWKB, record JSON and the complete stored link set. Migration 006 grants only the column reads required for evidence resolution and retries. It does not infer or transform geometry or assert that a support relation proves the geometry's meaning.

Root independently passed WSL Ubuntu-26.04 checks with native Linux Node.js `v24.21.0` and npm `11.19.0`: `npm run db:test` 58/58; `npm test` 127/127 (web 5, Worker 52, database 58, evaluation 12); `npm run typecheck`; `npm run build` (Vite production build and Wrangler dry-run); and `git diff main...HEAD --check` using the linked-worktree Git directory. PGlite uses local synthetic rows and does not establish hosted Postgres/Neon behavior, source rights, or semantic/factual validation. An initial concurrent dry-run hit WSL memory pressure; the isolated build passed.

### L1-WRITE-IDEMPOTENCY-CORE — accepted

Root reviewed and integrated `work/L1-WRITE-IDEMPOTENCY-CORE` at `59e59e8`, from implementation commit `c333ecd` and handoff commit `aa31f9a`. The writer inserts on the caller's dataset/revision key, compares every immutable typed field and JSONB record on retry, and returns a stable typed conflict for any changed payload. Evidence references use a database-enforced natural key and preserve their first trace on replay. Migration 007 refuses duplicate legacy identities without changing their rows and adds no role grants. Root independently passed `npm run db:test` 60/60, `npm test` 129/129 (web 5, Worker 52, database 60, evaluation 12), `npm run typecheck`, `npm run build` (Vite and Wrangler dry-run), and WSL `git diff --check` using Node.js `v24.21.0` and npm `11.19.0`. A test-only GEO-STORE-CORE ambiguity fixture was removed because duplicate evidence references are no longer representable after migration 007. PGlite does not establish multi-session hosted PostgreSQL/Neon concurrency. The next local processor is assigned below.

### L1-FIXTURE-PIPE-CORE — accepted

Root reviewed and integrated `work/L1-FIXTURE-PIPE-CORE` at merge `e5b1647` from implementation commit `01c9bac` and handoff commit `ea117d7`. The injected processor receives only an already-leased synthetic moderator submission, looks up its exact URL in an in-memory fixture catalog, builds a closed schema 2.0 unreviewed report from explicit manifest fields, and persists prepared text, support references, deterministic chunks, and only explicitly mapped 2D geometry. It does not claim jobs, fetch sources, update source health, or publish events. Empty fixtures complete with no incident rows or all-clear interpretation; stale or uncertain queue acknowledgements do not issue an unsafe second transition. The Worker suite passes 62/62, typecheck and build pass, the new PGlite integration passes 1/1 under the L1 role, and each of the eight DB test files passed individually. At that acceptance point, aggregate `npm run db:test` and `npm test` exited 1 without a DB failure summary; DB-TEST-RUNNER-ISOLATION later added a fail-visible sequential runner, whose aggregate checks now pass. PGlite is single-session and does not establish hosted Neon behavior.

### DB-TEST-RUNNER-CORE — prior investigation

Root reviewed `work/DB-TEST-RUNNER-CORE` in `.codex-build/worktrees/db-test-runner-core`. That 25 September run passed `npm run db:test` (61/61 across eight DB files) and `npm test` (140/140), so no runner change was justified then; it did not explain an older failure. After L3 added the ninth DB suite, new WSL runs reproduced aggregate exits: `npm run db:test` twice exited 1 without assertion details; `npm test` passed web 5/5 and Worker 62/62, then exited 1 in the DB workspace; and a one-worker Node test-runner attempt exited after migrations reported 8/8 without a final summary. Each of the nine DB files passes in a separate WSL process (68 tests), which root independently confirmed for L3 6/6 and migrations 8/8. No diagnosis is claimed yet.

### DB-TEST-RUNNER-ISOLATION — assigned on 26 September

Root assigned [DB-TEST-RUNNER-ISOLATION](assignments/DB-TEST-RUNNER-ISOLATION.md) to diagnose the new aggregate failure and, if needed, run every DB test file in a separate sequential Node process while preserving all output and failure statuses. No tests or assertions may be skipped or weakened and no dependency may be added. The implementation branch is `work/DB-TEST-RUNNER-ISOLATION` in `.codex-build/worktrees/db-test-runner-isolation`.

### DB-TEST-RUNNER-ISOLATION — accepted

Root reviewed and fast-forwarded `work/DB-TEST-RUNNER-ISOLATION` to `main` at handoff `805ccd4` (`cac88f9` implementation, `805ccd4` handoff). The database script discovers all `*.test.ts` files in stable order and runs each in a separate Node/tsx process, preserving child output and returning non-zero for failures, spawn errors, and signals. A parent interrupt cancels the active test and marks later files as unrun. No dependencies, test assertions, migrations, lockfiles, or product behavior changed. The runner never retries failures.

Root independently passed WSL Ubuntu-26.04 `npm run db:test` (9/9 files, 68/68 tests), `npm test` (147/147: web 5, Worker 62, DB 68, evaluation 12), `npm run typecheck`, `npm run build` (Vite and Wrangler dry-run), and WSL `git diff --check` with explicit Git directory/worktree paths. The original silent aggregate exit and one transient silent `migrations.test.ts` exit remain unexplained; the final retries and aggregate runs passed, and the runner returns any recurrence as a failure.

### L1-EVIDENCE-RELATION-ALIGN-CORE — accepted

Root accepted `work/L1-EVIDENCE-RELATION-ALIGN-CORE` at merge `7dd8ea7`, from implementation `34ecb04` and handoff `9b8f20a`. Forward migration 009 changes only the evidence-reference relation check, preserving existing rows and admitting the four existing schema 2.0 values. L1 writes and L2 retrieval preserve `updates` without remapping it, and the L4 policy continues to reject `updates` as claim support. Root independently passed `npm run db:test` (9/9 files, 70 tests), `npm test` (149/149: web 5, Worker 62, DB 70, casebook 12), `npm run typecheck`, `npm run build`, and WSL `git diff --check`. PGlite does not prove hosted PostgreSQL/Neon behavior. The requested `docs/api/openapi.yaml` restoration was applied from `main` and verified to have no diff. ADR-015 and its context writer now follow as the next local slice, using migration 010.

### API-PROJECT-CORE — accepted

Root reviewed and merged the pure Layer 4 public projection from `work/API-PROJECT-CORE`. It validates the consumed fields of schema 2.0 event/impact inputs, resolves names and explicitly rights-approved source attributions, matches exact event/impact versions, and creates the existing public `EventView` using a field allowlist. Adversarial synthetic tests verify private metadata is stripped, failures are bounded, source publication/observation times remain distinct, and schema-valid mixed date/date-time ranges remain unmodified. This does not wire a database reader or route. Source/data rights remain pending.

Root independently passed WSL Ubuntu-26.04 `npm test` (5 web, 52 Worker, 40 DB, 12 evaluation; 109 total), `npm run typecheck`, `npm run build` (Vite and Wrangler dry-run), and `git diff main...work/API-PROJECT-CORE --check` on the final branch.

### PUB-WRITE-CORE — accepted

Root reviewed and merged `work/PUB-WRITE-CORE` at `b2fb994`, from implementation commit `3889e75` and handoff commit `cc7a51b`. It adds a transaction-scoped Layer 4 writer and migration 005 for explicitly approved event/impact versions. The writer checks the configured live namespace, current event and impact versions, proposal/evidence lineage, origin and source-supported geometry, then atomically appends decisions, immutable versions and relations, audit, a dataset-scoped receipt and a payload-minimal outbox. Stable replays/conflicts, concurrent creates, role restrictions and rollback are covered by authored synthetic/live-shaped tests. It adds no route, authentication or source integration.

Root independently passed WSL Ubuntu-26.04 checks with Node.js `v24.21.0` and npm `11.19.0`: `npm run db:test` 50/50; `npm test` 119/119 (web 5, Worker 52, DB 50, evaluation 12); `npm run typecheck`; `npm run build` (Vite and Wrangler dry-run); and `git diff main...HEAD --check`. The linked-worktree Git check required explicit `GIT_DIR` and `GIT_WORK_TREE` because its `.git` pointer contains a Windows path. PGlite does not verify hosted Neon transaction/concurrency behavior.

### EVAL-01-TOOLS — accepted

The implementation branch `work/EVAL-01-tools` was accepted into `main` at `9f80600`. It adds `docs/evaluation/CASEBOOK.md`, `docs/evaluation/casebook.schema.json`, the authored synthetic fixture, and the standalone validator/tests under `tools/evaluation/`; root recorded the assignment status in `docs/assignments/EVAL-01-TOOLS.md`, updated the backlog and delivery log, and refreshed this checkpoint. The format is metadata-only, rejects live data and split leakage, separates reviewer records from adjudication, and checks all ten category and four scenario coverage gates. These rules prepare future evaluation but do not assert real source rights or labels.

Root independently ran the final integrated tree in WSL Ubuntu-26.04 using native Linux Node.js `v24.21.0` and npm `11.19.0`. `npm test` passed 100/100 (web 5, Worker 43, DB 40, casebook 12); `npm run typecheck`, `npm run build` (Vite production build and Wrangler dry-run), and `git diff --check` passed. Source/data rights remain pending; no real incident records or human judgments were used.

JOB-01 (`work/JOB-01-durable-queue` at `6d92eb0`) was reviewed and merged as `0d49f9e`. It adds `apps/db/migrations/002_acquisition_jobs.sql`, `apps/db/src/queue.ts`, acquisition-queue ports, migration/queue tests, and the JOB-01 handoff. The queue enforces dataset-scoped idempotency, source eligibility, finite lease/attempt/retry rules, recovery, restricted L4 enqueue privileges, and source-health-only updates. Root also made Worker test discovery explicit in `apps/worker/package.json` and removed the test side-effect import from `apps/worker/test/api.test.ts` (`3a40f60`), so API, parser, and L2 suites run once each.

Root ran `npm run db:test` on the final JOB-01 branch (21/21), then `npm test` on merged `main` (47/47: web 5, Worker 21, database 21), `npm run typecheck`, and `npm run build` in WSL Ubuntu-26.04 using Node.js `v24.21.0` / npm `11.19.0`. Vite and Wrangler dry-run passed. The root WSL checkout needed the documented `npm ci --offline --no-audit --no-fund` install (88 packages); the lockfile remained unchanged. Repository `git diff --check` passed. No route changed, so no smoke test was needed.

Root updated `docs/assignments/JOB-01.md`, `docs/IMPLEMENTATION_BACKLOG.md`, `docs/DELIVERY_LOG.md`, and the checkpoint to record acceptance. It then defined DATA-02-CORE (`87452c8`) as a synthetic-only L1 text preparation and chunk-persistence slice and defined RAG-CORE (`4e1531b`) as a separate deterministic retrieval boundary. Both planning commits are on `origin/main`. No live source, provider, model, cloud account, paid service, or deployment was used.

DATA-02-CORE was implemented on `work/DATA-02-core-text-pipeline` in `.codex-build/worktrees/data-02-core`; root reviewed and merged it as `31bf43e`. The implementation adds versioned text normalization, scoped contact redaction, deterministic evidence chunking, metadata-only persistence and invalidation, and the narrowly approved column-level L1 reads in migration 003. Root independently ran WSL Ubuntu-26.04 checks on merged `main` with Node.js `v24.21.0` / npm `11.19.0`: database tests 27/27, all workspace tests 57/57 (web 5, Worker 25, database 27), typecheck, Vite production build, Wrangler deploy dry-run, and `git diff --check` all passed. The accepted handoff and limits are in `docs/assignments/DATA-02-CORE.md` and `docs/DELIVERY_LOG.md`.

### L2-CONTEXT-PERSIST-CORE — accepted — 26 September 2026

Root reviewed and merged `work/L2-CONTEXT-PERSIST-CORE` at merge `6effd54c9ec3b8a794f4410925f14ce1cb3fdb55`. The implementation commit is `9c5f58228990b828a3fc643f0e16fe718cc14eec`; schema-parity correction `25454b5078765161eb7ff232bebd4860f71b0378` counts schema `Strings` limits by Unicode code point and preserves repeated `revision_states` entries allowed by schema 2.0. Handoff commits are `075ddd384a2e0eb641df621fd53bf8e9cb821898` and `ab092bd2234baca9ccd42418307bef939eb128d8`.

Migration 010 and the typed `GroundingContext` repository store only canonical reference metadata and normalized evidence/event-version/prior-decision links. Writes require a transaction, resolve references in the same dataset, create-or-verify immutable rows and links, and use a separate `NOLOGIN NOINHERIT` writer role with exact column/table grants. `sufficient` is preserved without evaluation; no retrieved excerpt, model output, source copy, route, Worker/Neon wiring, or publication action is included.

Root independently ran WSL Ubuntu-26.04 checks with Node.js `v24.21.0` / npm `11.19.0`: `npm run db:test` passed 10/10 files (77 tests); `npm test` passed 156/156 (web 5, Worker 62, DB 77, casebook 12); `npm run typecheck`, `npm run build` (Vite production build and Wrangler deploy dry-run), and `git diff d45f137..HEAD --check` passed. The detailed implementation and follow-up checks are in [the handoff](assignments/L2-CONTEXT-PERSIST-CORE-HANDOFF.md).

PGlite verifies local behavior only; Neon/hosted PostgreSQL role setup, concurrency, and Worker wiring remain unverified. Rights-cleared source data, human labels, retrieval quality, and sufficiency evaluation remain gated. No hosted resource was created or deployment performed.

## Limits and next work

- API-PROJECT-CORE and API-GEOMETRY-CORE are accepted as pure Layer 4 allowlist projectors for `EventView`, `EventDetail`, and GeoJSON. Existing database `public_event_*` views still expose full internal schema 2.0 `record_json`; no view output can be serialized directly as these public DTOs. ADR-012 records the boundary. API-DETAIL-HISTORY-ROUTES-CORE adds demo-only detail/history handlers; API-01 still needs a public-read database/role composition and the GeoJSON route. The GeoJSON `bbox` contract also needs documented Jakarta viewport bounds.
- `PUB-WRITE-CORE` is accepted for local persistence only. Before an HTTP route uses it, MOD-01 must provide authenticated reviewer authorization and the shared L4 role must be replaced by a dedicated narrower runtime role. Source/data rights and hosted transaction behavior remain unverified.
- EVAL-01-TOOLS is accepted as local metadata validation and readiness gating only. Root independently passed `npm test` 100/100 (web 5, Worker 43, DB 40, casebook 12), `npm run typecheck`, Vite production build, and Wrangler deploy dry-run in WSL Ubuntu-26.04 with Node.js `v24.21.0` / npm `11.19.0`. The checker cannot verify external rights, reviewer identity, label truth, representativeness, or a genuine held-out freeze.
- Source/data rights remain pending, so no real incident material has been collected, retained, or labeled. The four required evaluation scenarios and ten categories are coverage gates, not claims of current data coverage.

- JOB-01 is accepted as local queue behavior. PGlite uses one in-memory database connection and cannot prove locking across concurrent PostgreSQL sessions; Neon and hosted Worker behavior remain unverified.
- DATA-02-CORE is accepted as local synthetic implementation. Pattern redaction is incomplete; PGlite does not prove Neon compatibility or concurrent locking across independent sessions; no live source, provider, or cloud behavior was exercised.
- `RAG-CORE` is accepted as a local-only Layer 2 retrieval module. Synthetic records and fixed vectors preserve provenance and contradictions, but do not prove retrieval quality or sufficiency. Its evidence-reference row cap does not guarantee a bounded physical database scan.
- `RAG-ACCESS-01` is accepted: a NOLOGIN role has only query-required column-level reads, and the real retrieval SQL passes in synthetic PGlite under `SET ROLE` across non-semantic, semantic, geometry, and combined paths. The role is not yet wired to a Worker connection or hosted Neon service.
- `PUB-POLICY-CORE` is accepted as a pure L4 assessment requiring explicit authorized moderator approval and exact evidence, source/revision/remit/freshness, source-linked geometry, and event-version checks. It performs no write or authentication; its live-only output rule holds historical and synthetic cases. Human quality evaluation and transactional rechecks remain outstanding.
- `GEO-STORE-CORE` is accepted as local L1 geometry persistence with exact evidence linkage and least-privilege reads. Geometry role mapping and source semantics remain the responsibility of a reviewed source adapter; no live PetaBencana fields or geometry meaning have been verified.
- `L3-LEDGER-CORE` is accepted as local durable investigation persistence; tool/model invocation is not implemented. PGlite proves local behavior only and does not establish hosted PostgreSQL concurrency.
- `DB-TEST-RUNNER-ISOLATION` is accepted; `npm run db:test` and `npm test` pass with the sequential per-file launcher. The cause of the earlier silent exit and one transient migration-suite exit remains unknown; any recurrence is returned as a non-zero failure without retry.
- Future live operation still needs source reuse/attribution/rate/retention approval and non-empty source field mapping; human-adjudicated evaluation labels; a no-cost backup/restore/deletion path; model/provider selection and quota; basemap/geocoder/privacy terms; and measured Cloudflare/Neon behavior.
- No live-source activation, model call, cloud provisioning, paid service, or production deployment is enabled.
- RAG-CORE is accepted on `main` at merge `5e739cf`, from task head `7c6ded1` on `work/RAG-CORE-hybrid-retrieval`. Root independently ran database tests 38/38, all workspace tests 69/69 (web 5, Worker 26, database 38), typecheck, build/Wrangler dry-run, and WSL diff check.
- RAG-ACCESS-01 was implemented on `work/RAG-ACCESS-01-l2-reader` in `.codex-build/worktrees/rag-access-01` and accepted into `main`; the handoff and root review are recorded in the assignment and delivery log.
- PUB-POLICY-CORE was implemented on `work/PUB-POLICY-CORE-manual-gate` in `.codex-build/worktrees/pub-policy-core` and accepted into `main`; the branch handoff and root review are recorded in the assignment and delivery log.
- EVAL-01-TOOLS was implemented on `work/EVAL-01-tools` in `.codex-build/worktrees/eval-01-tools` and accepted into `main`; the assignment, delivery log, and synthetic fixture document its schema, leakage checks, category/scenario readiness gates, handoff, and limitations.
- The public projection boundary is recorded in `docs/decisions/ADR-012-public-projection-boundary.md`; `API-PROJECT-CORE` is assigned for a pure L4 projector with live-shaped synthetic tests and no route/database wiring.
- `API-PROJECT-CORE` is accepted on `main` at integration commits `c383faa` and `249c5e2`; the assignment, architecture and delivery log record the final branch review and independent WSL checks.
- The publication transaction boundary is recorded in ADR-013; `PUB-WRITE-CORE` is accepted on `main` at `b2fb994`, with exact commits, WSL checks and limits recorded in its assignment and the delivery log.
- The DATA-02-CORE acceptance checkpoint and docs are pushed to `origin/main` at `be4c366`. RAG-CORE's bounded design and exact implementation paths are recorded in its assignment and delivery log.

---

# Earlier Pause Checkpoint and Resumption Notes

**Checkpoint date:** 25 September 2026
**Reason:** Work paused at the user's request.
**Repository:** `D:\Projects\RPL`
**Remote:** `origin` → `https://github.com/Asassinoooo/Waspada-Jakarta.git`

## Integrated project state

The product is a civic safety information service for Jakarta residents and visitors. It presents reported incidents and disruptions with source evidence, event and observation times, freshness, location scope, and an explicit demo/live distinction. Its architecture follows five layers: (1) data and knowledge, (2) models and grounding, (3) bounded inference and orchestration, (4) application integration and deterministic publication rules, and (5) evaluation and monitoring. Provenance, privacy, prompt-injection isolation, audit, and human review apply across the system.

The accepted local implementation includes:

- **BOOT-01:** React/TypeScript demo UI and read-only TypeScript Worker API using synthetic data.
- **UI-00:** Responsive discovery/feed/map, event detail, and read-only moderator evidence review. Map geometry is shown only when supported by a documented fixture; status, freshness, evidence, and time fields remain distinct.
- **PLATFORM-01:** Free-tier compatibility assessment, with provider behavior and backup requirements explicitly unverified.
- **DATA-01:** Local PostgreSQL-compatible schema, migration runner, repository ports, and PGlite tests for provenance, reports, traces, audit records, spatial/semantic storage, and hash lineage. This is not Worker or Neon integration.

Planning/specification files include `SOFTWARE_DEVELOPMENT_PLAN.md`, `PROJECT_PLAN.md`, `ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`, `docs/UX_API_SPEC.md`, `docs/SOURCE_FEASIBILITY.md`, `docs/PLATFORM_COMPATIBILITY.md`, the API/schema contracts, ADRs, and the implementation backlog. Detailed work history and prior verification are in `docs/DELIVERY_LOG.md`.

## Repository and branch status at pause

| Branch/worktree | State |
| --- | --- |
| `main` | At `41324d4` before this checkpoint; clean and in sync with `origin/main`. Contains accepted BOOT-01, UI-00, PLATFORM-01, and DATA-01. |
| `work/BOOT-01-runtime-skeleton` | Accepted and merged; retained clean at `21f049e`. |
| `work/UI-00-civic-interface` | Accepted and merged; retained clean at `eddb962`. |
| `work/DATA-01-postgres-foundation` | Accepted and merged; clean at `b996c72`, also pushed to its origin branch. |
| `work/PLATFORM-01-free-compatibility` | The accepted report and cadence-documentation correction at `4b4908c` are integrated; the task branch is retained clean for traceability. The merge and root review are recorded in `docs/DELIVERY_LOG.md`. |
| `work/JOB-01-durable-queue` | Local WIP commit `0d51db0` preserves the interrupted initial migration and assignment handoff. Not pushed, tested, reviewed, merged, or accepted. |

JOB-01 implementation was interrupted and its agent halted. The only implementation artifact is `apps/db/migrations/002_acquisition_jobs.sql`, an initial queue-table draft. The WIP commit also updates `docs/assignments/JOB-01.md` to record what is incomplete. Do not apply or treat this migration as accepted. No JOB-01 tests were run.

## Verification completed before this checkpoint

Runtime and database tests were run in WSL Ubuntu-26.04 using native Node.js `v24.21.0` and npm `11.19.0`:

- **BOOT-01:** `npm ci --offline --no-audit --no-fund`, smoke checks against local Vite/Worker routes, 6 tests, typecheck, production build, Wrangler dry-run, and `git diff --check` passed.
- **UI-00:** 9 tests (5 web, 4 Worker), typecheck, local smoke, production build/Wrangler dry-run, and diff check passed. Desktop and mobile screenshots were reviewed; screenshots are retained in ignored `.codex-build/ui-00-review/`.
- **PLATFORM-01:** typecheck, 9 tests, smoke, build/Wrangler dry-run, and diff check passed for the task. Root separately checked the task diff. Provider quotas, performance, Workflows, and hosted database behavior were not tested.
- **DATA-01:** root independently verified 11/11 database tests, 20/20 overall tests (5 web, 4 Worker, 11 database), typecheck, build/Wrangler dry-run, local smoke, and diff check after the accepted branch fixes.
- **Planning/contracts:** OpenAPI validation covered 16 paths/operations and 176 local references; all embedded examples and 14 synthetic domain-contract examples validated. Markdown, schema, and diff checks are recorded in the delivery log.

These checks do not cover a live source, model provider, hosted Neon database, Cloudflare deployment, or production user study. No LaTeX compiler, cloud resource, paid service, secret, or live data connector was added or enabled.

## Unresolved decisions and gates

- Obtain and document reuse, attribution, rate, and retention permission for each live source.
- Establish a no-cost encrypted backup, restore, and deletion-replay path before persisting live-source data.
- Select and evaluate the model/version and confirm any free-tier model availability; keep model access behind an adapter until then.
- Confirm basemap, geocoder, gazetteer, database-region, and privacy terms.
- Measure actual Cloudflare/Neon workloads, quotas, latency, and stop thresholds using an authorized provider setup before deployment.
- Collect user research and human-adjudicated evaluation labels; no labels or safety-coverage claims are inferred from synthetic fixtures.
- Finish moderator authentication, publication rules, incident correction/retraction propagation, ingestion, retrieval, bounded investigation, and public API work according to the backlog.

## Resume point

The next route-sized task depends on selecting and documenting Jakarta viewport bounds and their basis; the requested user choice is still pending, so do not invent or implement `bbox` bounds. Until then, keep database-backed public reads, source acquisition, model/sufficiency quality claims, and live publication gated on their missing rights, contracts, and human evaluation. Do not enable live sources, providers, or cloud services.

## Autonomous development resumed — 25 September 2026

The user resumed the broader local-development goal. Root verified that `main` was clean at `da49689` and matched `origin/main`; the JOB-01 branch was clean at `0d51db0`. The interrupted Luna Max agent has been reactivated on JOB-01. No JOB-01 results are accepted yet.

Root separated deterministic fixture parsing from scheduled acquisition and human evaluation gates. The backlog now includes **ING-PARSE-01**, a local-only PetaBencana-style GeoJSON parser task that uses synthetic fixtures and requires no JOB-01 queue, EVAL-01 labels, network, persistence, or new dependency. Its scope is in `docs/assignments/ING-PARSE-01.md`. `ING-01` remains the later queue-to-L1 acquisition/activation integration and still requires its defined dependencies and source approvals.

Root also added **L2-ADAPTER-01** for strict typed classifier/extractor/embedder/reasoner contracts, evidence-bound validation, explicit no-provider behavior, and test-only doubles. It separates locally verifiable interface safety from **AI-01** provider selection and benchmarking, which still depends on human-adjudicated cases and current provider access. No model/API call is enabled.
