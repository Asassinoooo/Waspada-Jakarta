# Waspada Jakarta — Project handoff

**Updated:** 18 October 2026 · **Team:** 12 · **Audience:** any coding agent or developer.

This document is self-contained project context. It requires no particular assistant, model, editor, connector, previous conversation, or agent session. Use ordinary repository files, Git, and terminal commands. Directory names such as `.codex-build` are existing artifact locations, not a requirement to use that product.

**Code baseline:** `d007d02f8f277e64ec7ea10f15b82a80c414b860` on `main`, `docs(AUTH-01): accept local accounts onboarding and setup guide`. At the start of this documentation task the checkout was clean; `git fetch origin` succeeded and `HEAD...origin/main` was `0 0`. This handoff adds documentation after that baseline. Recheck the current checkout before continuing.

**Repository:** [Asassinoooo/Waspada-Jakarta](https://github.com/Asassinoooo/Waspada-Jakarta). Current machine: `D:\Projects\RPL`; WSL path: `/mnt/d/Projects/RPL`.

## 1. Read first and establish current state

1. Read [SOFTWARE_DEVELOPMENT_PLAN.md](SOFTWARE_DEVELOPMENT_PLAN.md) first. It owns scope, requirement IDs and acceptance gates. Then use this handoff as the concise continuation guide.
2. Check local instructions such as `AGENTS.md` if present. That file is intentionally ignored and may be absent in a fresh clone; the essential project constraints are repeated here.
3. Read the relevant row in [IMPLEMENTATION_BACKLOG.md](docs/IMPLEMENTATION_BACKLOG.md), its assignment under `docs/assignments/`, and related contracts/ADRs before editing.
4. Treat [DELIVERY_LOG.md](docs/DELIVERY_LOG.md) and dated assignment handoffs as historical evidence. Older bootstrap/checkpoint paragraphs can describe superseded behavior. The latest accepted account slice is 15 October 2026.
5. Inspect Git state and existing processes before editing files or starting another service:

```sh
git status --short
git branch --show-current
git log -8 --oneline
git remote
git worktree list
```

Do not reset another contributor's work, delete state, merge every historical branch, or assume a previous service is running. If updating remote knowledge is needed, fetch without automatically pulling or rebasing someone else's changes. Inspect remote URLs only when needed and never echo an embedded credential into logs.

**Verification on 18 October:** this task audits files/Git and creates documentation only. It does not rerun application tests, start servers, install dependencies, acquire source reports, call models/Google, or verify deployed services. Results below are dated historical results, not freshly executed tests.

## 2. What the product is

Waspada Jakarta helps residents and visitors understand a reported incident, whether it may affect them, how current the information is, and what evidence supports it. It is a calm, Bahasa Indonesia civic information service, with a map-oriented web experience and an independently useful report list. It is not an emergency dispatcher or a guarantee that an area is safe.

Coverage categories include crime/personal security, demonstrations, crowds/major events, immediate threats, weather/disasters, fires/infrastructure, transport, utilities, health/environment and group-specific critical notices. Having a category does not mean a real source for it is integrated.

The repository contains a substantial locally tested prototype and component foundations. It is **not a complete deployed live safety platform**. Keep these paths separate:

The stack is an npm/TypeScript workspace with React/Vite web, a Cloudflare Worker API, PostgreSQL/PostGIS/pgvector persistence components and local PGlite test/demo databases; the Android client is Flutter/Dart. Local Node timers and file-backed databases are not a deployed Worker scheduler or hosted database.

| Path | Implemented state | Boundary |
| --- | --- | --- |
| Published-incident demo | Labelled synthetic context, list, details, reviewed history and public UI | No real warning feed; default public GeoJSON is empty because these fixtures lack supported geometry |
| Unified source map | OSM facility snapshot; explicit bounded OSM/PetaBencana/Open-Meteo/USGS preview requests; clustering | Source/context previews are not reviewed published incidents; no LLM or source-to-publication pipeline is invoked |
| Local private pipeline | Authored JSON feed → immutable snapshots/durable jobs → L1 evidence → L2 extraction/embedding/retrieval → private proposals; loopback inspector | Separate disposable PGlite; mocks by default; no public event publication, real-source polling, or L3 tool dispatch |
| Accounts | Google web/native adapters, durable role-scoped accounts/sessions, guest/account onboarding, desktop account administration | Google clients and hosted bindings are not configured; the opt-in local browser demo uses synthetic identities |
| Android Flutter | Public reader/details/history/local interests/guide plus optional Android account/onboarding | No native admin/moderation dashboard; native maps, briefings, update polling and incident offline cache remain deferred |
| L3/L4 components | Bounded investigation, ledger/checkpoint/recovery and publication-policy/writer components with synthetic integration proofs | No complete hosted autonomous investigation or authenticated incident-publication route is activated |

## 3. Architecture and rules that must survive changes

Read [ARCHITECTURE.md](ARCHITECTURE.md), [DOMAIN_MODEL.md](docs/DOMAIN_MODEL.md) and the relevant ADR before crossing a boundary.

| Layer | Responsibility | Must not take over |
| --- | --- | --- |
| L1 — Data & Knowledge | Approved acquisition, cleaning, deterministic preparation, revisions, evidence/chunks, spatial and embedding persistence | Autonomous investigation or publication. A fixed L2 extraction adapter may be called by L1 |
| L2 — Model & Grounding | Task-specific model adapters, retrieval before investigation, evidence-bound assessment and typed proposals | Source approval, self-granted tools/budgets, or direct publication |
| L3 — Inference & Orchestration | Investigate gaps only after initial context is insufficient; bounded tools, checkpoints, stop/escalation | Routine ETL, authoritative storage, unrestricted retries, or publication |
| L4 — Application Integration | APIs, accounts/authorization, deterministic publication gate, reviewed event versions and public projections | Accepting model confidence or valid JSON as factual proof |
| L5 — Evaluation & Monitoring | Metrics, audit, quality/cost/latency/source-health evaluation across all layers | Silently changing evidence policy or training on private feedback |

Responsible AI applies throughout: preserve source provenance and contrary evidence, isolate source text from instructions, enforce permissions and dataset boundaries, minimize private data, and retain auditable decisions.

**Product invariants:**

- Keep incident lifecycle, evidence status, freshness and personal relevance distinct. Expiry, unavailable sources and no reports never prove resolution or physical safety.
- Show event/observation time separately from issuer publication, system acquisition and processing time; do not invent missing timestamps.
- Map only supported points, official boundaries or documented segments. Do not invent danger radii or convert historical crime records into current danger zones. OSM facilities do not imply readiness.
- Clusters count loaded records per provider; they do not establish incidents, severity or independent corroboration. Preserve exact source coordinates.
- Published-event APIs expose reviewed published versions only. Preview/private proposal paths remain separate. Label all synthetic/historical fixtures and isolate them from live data.
- Keep the current published version visible pending moderator review of retracted/superseded/withdrawn supporting evidence. Mark event freshness and directly affected impacts `needs_update`; preserve unrelated impacts.
- Passing `review_due_at` means `needs_update`; only issuer validity establishes `expired`. Event aggregation is conservative. Public claims share event freshness; impacts have their own freshness.
- Freshness records are append-only against exact versions. Freshness alone creates no `/updates` item or cursor advance. Reviewed version history needs a moderator-reviewed label/summary; withdrawn versions and their event history stay hidden.
- Direct proposals and moderator corrections must pass the same L4 gate. Public claim labels are moderator-selected; they do not replace evidence eligibility. Account roles alone do not enable incident writes.
- Failed L3 attempts count against budgets; resumes preserve usage. A sticky uncertain-progress review marker is not execution fencing, cancellation proof or permission to retry.

Freshness/history decisions: ADR-026/032/038/039/042/046/048. L3 recovery: ADR-049/051. Public evidence labels: ADR-052. These files are indexed in [docs/decisions/README.md](docs/decisions/README.md).

## 4. Find the right files

| Need | Starting point |
| --- | --- |
| Scope, tasks, delivery evidence | [Software plan](SOFTWARE_DEVELOPMENT_PLAN.md), [backlog](docs/IMPLEMENTATION_BACKLOG.md), [delivery log](docs/DELIVERY_LOG.md), `docs/assignments/` |
| Web routes and views | [apps/web/src/App.tsx](apps/web/src/App.tsx), [main.tsx](apps/web/src/main.tsx), [UX/API specification](docs/UX_API_SPEC.md) |
| Worker route/runtime composition | [apps/worker/src/index.ts](apps/worker/src/index.ts), `apps/worker/src/runtime/`, [wrangler.toml](apps/worker/wrangler.toml) |
| Layer services | `apps/worker/src/layers/l1-data-knowledge/` through `l5-evaluation-monitoring/` |
| SQL, permissions and migrations | `apps/db/src/`, `apps/db/migrations/`, [migration runner](apps/db/src/migrations.ts), [SQL executor](apps/db/src/postgres-sql-executor.ts) |
| Local collection/AI composition | [processor](tools/local-pipeline/processor.ts), [store](tools/local-pipeline/store.ts), [scheduler](tools/local-pipeline/scheduler.ts), [local-pipeline guide](docs/LOCAL_PRIVATE_PIPELINE.md) |
| Private model transport and diagnostics | `tools/ai/`, [model plan](docs/AI_MODEL_INTEGRATION_PLAN.md), [gateway testing](docs/PRIVATE_AI_GATEWAY_TESTING.md) |
| Accounts | [account API](apps/worker/src/accounts/api.ts), [runtime](apps/worker/src/runtime/account-runtime.ts), [store](apps/db/src/accounts.ts), `tools/accounts/`, [guide](docs/ACCOUNTS_AND_ONBOARDING.md) |
| Android | `apps/mobile/lib/src/`, [mobile README](apps/mobile/README.md), `apps/mobile/test/`, `apps/mobile/android/` |
| Sources and evaluation | [source feasibility](docs/SOURCE_FEASIBILITY.md), [clearance plan](docs/SOURCE_CLEARANCE_PLAN.md), [verification plan](SOURCE_VERIFICATION_PLAN.md), `tools/evaluation/` |
| Hosting/free-tier constraints | [compatibility report](docs/PLATFORM_COMPATIBILITY.md), [ADR-010](docs/decisions/ADR-010-cloudflare-neon-free.md) |
| University report | Google Docs is maintained; current link is in [README](README.md). Keep research references in [REFERENCES.md](REFERENCES.md); do not install, compile or maintain LaTeX |

**Separate contracts:** domain/schema **2.0** in [contracts.schema.json](docs/contracts.schema.json); published HTTP **`/api/v1`** DTOs in [public-api.ts](apps/worker/src/contracts/public-api.ts); preview **`source-preview-v1`** and **`context-sources-v1`** in their Worker contract files; private inspector **`local-pipeline-preview-v1`**; identity **`account-v1`** in [accounts.ts](apps/worker/src/contracts/accounts.ts). The [OpenAPI](docs/api/openapi.yaml) includes future moderator operations; presence in that file is not proof of a registered route. Check runtime wiring and assignment evidence. Do not merge these namespaces or change public contracts incidentally.

There are 36 canonical migrations at the baseline, ending in `036_accounts.sql`. Do not renumber/rewrite applied migrations or weaken checksum/order guards. Historical migration tests must bound the intended version range; excluding a fixed list of known future filenames previously broke when 036 was added.

## 5. Local startup with ordinary terminals

Project startup, builds, formatters and tests must use **WSL Ubuntu-26.04**, not Windows-host Node/Flutter. This is a project execution constraint, independent of the coding tool. Paths below describe the existing machine; adapt checkout/tool locations while keeping project startup/build/test verification in WSL Ubuntu-26.04. Check installed tools before installing anything.

Recorded toolchain: Node 24.21.0 / npm 11.19.0, PGlite 0.5.8, Flutter 3.47.7 / Dart 3.13.5, Java 21. The lockfiles are authoritative; do not opportunistically upgrade dependencies. A fresh implementation checkout may need `npm ci`; this documentation task did not install anything.

```sh
# From a Windows terminal, first enter: wsl -d Ubuntu-26.04
cd /mnt/d/Projects/RPL
# Existing machine example, only if its Linux Node is not already on PATH:
export PATH=/home/perry/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin
npm run dev
```

| Port / URL | Purpose |
| --- | --- |
| `127.0.0.1:5173` | Vite browser app |
| `127.0.0.1:8787` | Local Worker; Vite proxies normal `/api/v1` calls |
| `127.0.0.1:8788` | Optional read-only private pipeline service |
| `127.0.0.1:8789` | Optional synthetic account service |

Public destinations: `#beranda`, `#jelajah`, `#demo-sumber`, `#ringkasan-saya`, `#bantuan`. Four main navigation groups stay intact; account utility is `#akun`. Account/onboarding: `#masuk`, `#mulai`. Web operator shells: `#admin`, `#tinjau-bukti`, subject to roles; private development inspector: `#pipeline-lokal`.

Checked-in Worker configuration is `DATASET_MODE=demo`, `SOURCE_PREVIEW_ENABLED=true`, with no hosted DB/auth binding or Cron configured. Browser input cannot switch datasets. Default incident fixtures are synthetic. The source demo separately serves a dated real OSM snapshot; explicit acquisition buttons can make network requests. Basemap tiles also require internet. Block/stub external requests during routine browser tests.

### Synthetic browser accounts

```sh
# Terminal A: explicit, durable, fictional local accounts; no Google calls.
npm run accounts:local -- --enable --demo --state accounts-demo

# Terminal B: set this BEFORE starting Vite; do not start a second Vite owner.
WASPADA_LOCAL_ACCOUNTS=true npm run dev
```

Open `http://127.0.0.1:5173/#akun`. The consent page says **DEMO LOKAL — akun rekaan, bukan Google** and offers pre-provisioned user/moderator/admin profiles. This is a test fixture, not signup role selection. Without the opt-in, Google login is unavailable and public browsing continues.

### Mocked local pipeline and inspection

```sh
# Safe default is disabled.
npm run pipeline:local
# One bounded authored-feed/mock-model cycle in separate state.
npm run pipeline:local -- --enable --once --state handoff-demo
# After its owner stops: counts only, no inference.
npm run pipeline:local -- --status --state handoff-demo

# If web/Worker already run, add one finite mock collector/inspector:
npm run pipeline:serve -- --enable --watch --state app-demo --interval-ms 5000 --max-polls 60
```

`npm run dev:pipeline` is an alternative that starts web/Worker/inspector together. Do not run it alongside another owner of the same ports. For account plus pipeline demo, enable the account proxy on the Vite process as above, and start the separate account/pipeline services once each.

**State ownership:** accounts use `.codex-build/accounts/<state>`; pipeline uses `.codex-build/local-pipeline/<state>`. Both are ignored, synthetic and disposable, but must not be shared with a real application database. Use one process per state; even pipeline status/reopen waits until its prior owner stops. Inspect through the running inspector instead. Do not clear a lock while its owner is alive. After a crash, verify the exact PID/process before removing an exact stale account lock. Profile/model/timeout/output-policy mismatches intentionally refuse reopen; do not bypass them.

### Android

Use the existing WSL Flutter/Android toolchain described in the [mobile README](apps/mobile/README.md). Existing Flutter binary: `/home/perry/.local/opt/waspada-flutter-3.47.7/flutter/bin/flutter`; Android SDK: `/home/perry/.local/opt/waspada-android-sdk`; Java: `/usr/lib/jvm/java-21-openjdk-amd64`.

```sh
cd /mnt/d/Projects/RPL/apps/mobile
# With the existing Linux SDKs on PATH/configured:
flutter analyze
flutter test
flutter build apk --debug
```

The generated APK is `apps/mobile/build/app/outputs/flutter-apk/app-debug.apk`; it is ignored and may be absent in a fresh checkout. Native Google sign-in requires configured HTTPS `API_ORIGIN`, a public web/server `GOOGLE_SERVER_CLIENT_ID`, Android package/SHA registration and server verification configuration. Never embed an OAuth secret. The Node synthetic browser account provider does not enable native sign-in; native account tests use injected SDK/API/storage doubles. Responsive browser account support lives in `apps/web`; Flutter web remains guest-only for accounts.

## 6. Accounts: preserve the security boundary

AUTH-01 latest details: [assignment/handoff](docs/assignments/AUTH-01-ACCOUNTS-ONBOARDING-HANDOFF.md), [ADR-059](docs/decisions/ADR-059-google-accounts-and-onboarding.md), [setup guide](docs/ACCOUNTS_AND_ONBOARDING.md).

- New verified Google issuer+subject creates a **user**. No email matching/domain, first-user promotion, browser storage edit, token role claim or onboarding choice may grant privilege.
- Visitor: public browsing/local interests/guest introduction. User: own account/onboarding/logout. Moderator: read-only web evidence-review example. Admin: read-only desktop incident dashboard plus audited account-role/active changes for another account. Android/narrow web have no dashboard/user-management controls.
- Web uses state/PKCE/nonce, signed Google ID-token checks, hashed opaque server sessions and production Secure/HttpOnly/Strict host cookies. Browser writes require exact Origin and **`X-CSRF-Token`**. An earlier server/client header mismatch was fixed; do not reintroduce it.
- Bind prior session rotation at login start: the Strict session cookie may be absent on the cross-site callback. Attempts are one-use; failed login preserves the prior session. Provider initialization failure must permit a later retry.
- Accounts/roles/sessions are permanently scoped to server-selected demo/live. Store factory: `createAccountStore(executor, datasetMode)`. A demo admin is not a live admin.
- Native verifies Google proof against fixed issuer/audience/JWKS and allowed Android authorized party, then issues a separate opaque app token held in OS secure storage. Native bearer sessions have own-account actions only, even for a privileged profile; no admin API or browser token storage.
- Current role/active state are revalidated server-side. Admin changes require reason/version, prohibit self change, append audit and revoke target sessions. Initial privilege is operator-only provisioning, with no public bootstrap endpoint.
- Session API idle limit 30 minutes / absolute 8 hours. Android offline logout clears the local token but cannot promise unconfirmed server revocation; expiry remains relevant. Account deletion/export and interest synchronization are not implemented.
- Migration036 and `waspada_auth_service` support a dedicated auth connection. Hosted LOGIN membership/Hyperdrive must be separately configured and verified. Do not reuse public/ingestion/model/publication credentials.

## 7. AI and sources: what has actually been proven

The source map, local synthetic pipeline and public-event runtime are separate compositions. Do not connect them by simply forwarding every preview object to an LLM or publication writer.

**Selected private test setup:** backend-only `NINEROUTER_URL` / `NINEROUTER_KEY` in ignored root `.env.local`; chat alias `Waspada-Jakarta`; embedding alias `gemini/gemini-embedding-2-preview` at **768 dimensions**. Catalog routes are `/v1/models` and `/v1/models/embedding`; generation routes are `/v1/chat/completions` and `/v1/embeddings`. Do not print endpoints, keys, raw prompts/provider errors or vectors. Do not add browser `VITE_` secrets.

The reasoning alias is a weekly curated rotating selection, not a pinned upstream model. User-reported Google project limits were 100 RPM / 30,000 TPM / 1,000 RPD, and the curated-model context floor was 128k with unmetered access. These are dated supplied facts, not independently verified current entitlements. The proposed 80% shared quota margin is **not an implemented global ledger**. No paid fallback is authorized. A free-text query-embedding port and versioned document/query representation remain separate work; never fabricate chunk lineage for a user query.

Large model context does not waive the current 12,000-total-token application validation. Request 768-dimensional embeddings explicitly: L1 accepts at most 2,048 dimensions, while the documented provider default 3,072 would not fit. Keep model/profile/dimensions/index identity together; changing embedding representation requires a separately versioned/re-embedded space, not mixing vectors silently.

**Timeout distinctions:** durable local real once/resume defaults to 900,000 ms per request and 901,000 ms processor fallback, with fenced five-minute leases renewed every 60 seconds. Standalone smoke remains 25 seconds. A separate extraction diagnostic supports no client deadline/output-limit omission. These are different opt-in profiles; do not replace them globally, promise infinite upstream execution, or change L3 budgets. Timeout/output policy is part of state ownership. Read [ADR-057](docs/decisions/ADR-057-local-long-model-waits.md) before changing it.

One synthetic durable attempt on 12 October completed extraction/embedding/grounding/reasoning/private persistence, but produced **zero claims and one unresolved item**. Both earlier full live smokes failed overall. This proves some transport/composition behavior, not useful-claim quality, full live compatibility or the cause of earlier extraction failures. Provider calls can repeat if a crash precedes a persisted stage receipt; do not claim exactly-once inference. Routine verification must use mocks. A previous permission to test is not an instruction for the next agent to spend quota; define a separate finite synthetic-only probe before another real call.

**Known local limits:** retrieval scans at most 16 global evidence rows / returns 8 matches, then scopes to the candidate; truncation or missing/invalid support fails closed as `context_insufficient`. More history can exhaust AI retries. A terminal ingestion predecessor can block a later report version; no repair/reset workflow is implemented. Do not silently raise caps, revive terminal work or invent successful reasoning to hide these limits.

**Source rights are use-specific.** The dated local OSM/PetaBencana educational preview and Open-Meteo/USGS context exceptions do not clear raw retention, embeddings, model transfer or production incident publication. The [clearance plan](docs/SOURCE_CLEARANCE_PLAN.md) records BMKG/media restrictions and unresolved dataset-specific terms. An open license may suffice for its covered use; public reachability by itself does not. Recheck authoritative terms when actually doing source work. Do not enable a real connector, scrape restricted interfaces, contact publishers or configure accounts as part of routine local work.

## 8. Verification commands and honest evidence

Run the smallest relevant checks in WSL. These commands are available; they are **not a claim that they were run during this handoff task**:

```sh
npm run typecheck
npm run test --workspace=@waspada/web
npm run test --workspace=@waspada/worker
npm run accounts:test
npm run db:test
npm run pipeline:test
npm test
npm run build
npm run smoke    # requires the local web/Worker services
git diff --check
```

`npm run build` includes Vite and Wrangler **dry-run**, not deployment. `npm test` includes workspace suites, evaluation/AI, isolated pipeline cases and account tools. DB/pipeline runners isolate files/cases because repeated PGlite/WASM instances can exhaust memory. Avoid simultaneous Android compilation and large DB suites; do not turn resource exhaustion into a product pass or remove isolation/order checks.

**Latest recorded acceptance, 15 October 2026:**

| Check | Recorded result |
| --- | --- |
| Web / Worker | 196/196 / 533/533 |
| Account tools | Four adapter/provider cases plus one real local HTTP/disk-PGlite composition passed |
| Evaluation/AI / private pipeline | 41/41 / 58/58, mocked providers |
| DB | Initial 43/46 files passed; three failing files recovered through migration/update fixtures 23/23 and isolated outbox 7/7. All 46 files covered across runs; **no single clean full `npm test` pass is claimed** |
| Typecheck/build/smoke | Passed; Worker dry-run upload 1172.01 KiB / gzip 230.95 KiB does not prove hosted free-tier CPU fit |
| Web visual QA | Ten mocked-account groups/ten screenshots plus seven actual loopback groups/four screenshots; desktop/mobile/320px200% reflow, zero page errors, external requests blocked |
| Flutter | Analyze passed,41 tests passed, debug APK 163,241,039 bytes built; no real Google/device/release/TalkBack proof |

The DB migration fixture bug and CSRF header mismatch were fixed, not waived. Exact commands, failed runs, corrections and commit messages are in the [AUTH handoff](docs/assignments/AUTH-01-ACCOUNTS-ONBOARDING-HANDOFF.md). Earlier documents have older counts. Ignored QA screenshots/manifests/state may not survive a clone; use tracked tests as the reproducible baseline. For future UI work use an isolated/headless browser, inspect desktop/mobile screenshots and large-text reflow, and do not take over the user's desktop.

## 9. Next work and gates

No implementation task is started by this documentation handoff. Choose one bounded item and check dependencies before coding. Preserve parent IDs instead of treating accepted component slices as completed parent features.

| Track | Existing IDs / useful next step | Gate or limit |
| --- | --- | --- |
| Local AI robustness | **RAG-01 / JOB-01**: characterize corpus-growth retrieval failures, then plan a bounded identity-aware retrieval repair; separately design terminal-predecessor recovery | Synthetic fixtures and mocks can progress locally. Preserve contrary evidence, truncation signals, restart/replay and no-publication boundary |
| Account follow-through | **AUTH-01** local slice is accepted; maintain security/composition regressions and prepare setup when requested | Real Google project/consent/web+Android clients, package/SHA, dedicated DB LOGIN and HTTPS hosting remain unconfigured |
| Source integration | **INT-01**, ingestion/source tasks: choose an exact permitted endpoint/use and document access, retention and model transfer | No blanket clearance from map preview; rights/privacy/retention conditions must cover each use |
| Evaluation | **EVAL-01** casebook tooling exists; collect only rights-cleared cases and obtain genuine review | Perry and Jesaya are nominated independent human reviewers; labels are not supplied. Target ≥40 reports, ≥12 incident cases, ≥3 reports/case, incident-level splits and held-out cases. Synthetic/model labels do not count |
| Investigation/runtime | **AGENT-01 / RAG-01**: component tests exist; hosted resumable runtime, execution fencing and end-to-end gap investigation remain work | Do not treat uncertain-progress holds as termination proof or open autonomous tools without budgets/assignment |
| Publication/moderation | **PUB-01 / MOD-01**: local gate/writer proofs exist | Incident review/source approval/correction/retraction/publication mutations remain deferred. AUTH-01 does not authorize them |
| Freshness | **LIFE-01** local components/projections exist | Team 12 explicitly paused the source-revision Worker after discovering that `waspada_l4_freshness_writer` lacks observation/lineage read grants. No role/grant change or runtime resumption is authorized; do not treat this as an invitation to widen access |
| Hosting | **PLATFORM-01 / INT-01**: prepare bounded free-tier verification/recovery plan | Cloudflare Workers/Neon Free are targets; hosted behavior, connectivity, budgets and off-provider recovery remain unverified. No paid upgrade/fallback |
| Mobile | Continue resident functionality only under a bounded UI task | Native map and other deferred features are not account-parity work already completed. No mobile admin scope |

**Recommended first local slice:** under RAG-01, add an end-to-end PGlite corpus-growth case in `tools/local-pipeline/pipeline.test.ts` before changing production logic. Read the processor, existing low-level `apps/db/test/evidence-retrieval.test.ts` truncation tests, proposal-roundtrip tests and model/local-pipeline guides so this adds coverage rather than duplicating it. Grow unrelated history beyond the 16-row/8-result window and prove that the target is either grounded with exact lineage or fails closed without a reasoning call; L1 remains persisted, retry state stays bounded, and publication/public rows stay empty. Start with tests only in the owned local-pipeline test area; use the existing literal-case isolated runner. Run `npm run pipeline:test` and relevant typecheck; record results. If a repair needs a new retrieval contract or SQL/grant change, make that a separately specified implementation slice/ADR. This is a recommendation, not an already assigned or implemented capability.

## 10. Working agreement for the next contributor

- Use the team's current instructions and the user's newest direction. This guide does not require vendor-specific orchestration or a particular model. If delegation exists, assign independent bounded packages; otherwise work sequentially and disclose any missing independent review.
- Make routine authorized local progress without repeatedly asking for permission. When a material decision is missing, use the environment's question interface if available, ask a concise question and continue independent work while awaiting its answer. External spend/service changes still need their separately scoped authorization.
- Before implementation write a short assignment: existing task/requirement IDs, objective, prerequisites, allowed paths, contract versions, acceptance cases, verification commands, allowed external actions/budget and stop/escalation conditions. Resolve shared interfaces before parallel edits.
- Each delegated implementer gets its own branch/worktree and coherent descriptive commits. A single contributor should also isolate feature work. Example: `git worktree add -b work/RAG-01-corpus-growth ../waspada-rag-growth main`. Use an available path; never reset an existing worktree. Adapt branch naming to local instructions.
- Do not have two contributors edit the same shared contract, migration, entry point or lockfile without a clear owner. Review diffs and actual check evidence before integration; an implementer cannot provide independent approval of its own work. If no reviewer is available, record self-checks and that limitation, and leave independent acceptance pending rather than claiming it occurred.
- Keep meaningful changes committed. Preserve history/authorship and stable IDs. The integration owner merges/copies only reviewed work and pushes coherent checkpoints to the existing remote under the user's standing direction. Do not force-push, deploy or modify provider configuration as an incidental step.
- Use model doubles/synthetic fixtures for routine tests. Do not publish, configure hosted resources, spend money, enable a real source or send messages to other people as a side effect of local implementation. Raise the exact required external decision when necessary; continue independent local work.
- Keep secrets, raw/private data, state, APK/build outputs, model weights, dependency caches and screenshots/manifests out of Git. Use the ignored `.env.local` /`.dev.vars` and safe example files; never request a secret in chat. Do not remove the existing ignore rules for local instruction/workflow files.
- Update the relevant plan/backlog/ADR/delivery log with accepted changes and actual limitations. Google Docs remains the university report format; local Markdown engineering docs are not the report itself.
- Hand back: branch/worktree; commit SHA(s) and exact messages; changed paths and behavior; actual commands/results; skipped/failed checks; migrations/configuration impact; unresolved decisions and the next bounded step. Label claims as implemented, locally verified, externally unverified, planned or deliberately deferred.

**Suggested first response after reading:** state the checked-out baseline and whether it is clean, identify the chosen existing task and its gates, then proceed with the bounded local work. Do not infer that this handoff itself approves a deployment, real-source activation, moderator mutation or new model run.
