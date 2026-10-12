# Local synthetic polling → private proposals

Local synthetic implementation accepted, 12 October 2026. Task: [JOB-01-LOCAL-PRIVATE-PIPELINE](assignments/JOB-01-LOCAL-PRIVATE-PIPELINE.md); design: [ADR-055](decisions/ADR-055-local-synthetic-polling-private-proposals.md).

This Node-only tool reads one team-authored JSON API fixture. It does not poll a real website. The collection loop detects stable report IDs and changes to title, text, publication time or observation time. It atomically stores each immutable version and its ingestion job in disposable file-backed PGlite. Versions preserve first-capture time and superseding revision identity; unchanged polls do not schedule new work. A→B→A produces three versions. Feed removal is not a retraction or proof of resolution; out-of-order issuer revisions are not established by this authored fixture.

```mermaid
flowchart LR
  F[Authored synthetic API fixture] --> P[Opt-in local timer]
  P --> I[Immutable snapshot + durable ingestion job]
  I --> L1[Prepare text → revision → evidence/chunks]
  L1 --> A[Separate durable AI job]
  A --> E[Typed extraction + embedding]
  E --> R[L2 persisted-evidence retrieval + grounding]
  R --> Q[Bounded reasoning → private proposal]
  A --> X[Retry/backoff or exhausted state]
  X -. retains .-> L1
```

Models run outside SQL transactions. Each successful stage records a validated receipt and canonical writes together under the current lease; retries read those receipts first. The tool can repeat a provider call if it crashes before recording the result, so this is not exactly-once inference. Timeouts and invalid output leave closed failure codes with up to five attempts, 30/60/120/120-second backoff, then a terminal job. Evidence remains available. Terminal jobs are retained for investigation; there is no automatic reset or publication action.

All revisions remain unreviewed. The one authored origin has unknown independence; retrieval of that exact synthetic candidate proves composition only. An insufficient context stops before reasoning/L3. L4 publication, moderator mutation and public event routes are disconnected. The tool does not change Cloudflare, Neon, real source access, scheduled Worker bindings or the map UI.

Retrieval currently scans at most16 global evidence rows and returns at most8 hybrid matches before selecting the exact candidate. Its preview is limited to2048 code points; selected spans are then rehydrated exactly. Any scan/result truncation, omitted invalid span or missing support stops as `context_insufficient` and can exhaust retries as history grows. This small synthetic proof does not establish scalable historical retrieval. Collection/L1 continue retaining reports during that stop. A terminal L1 version also leaves later versions of the same stable report retained but blocked by the canonical supersedes dependency; other report IDs continue. There is no automatic repair/reset operation in this slice.

## Startup in WSL Ubuntu-26.04

Use the installed dependencies: Node24.21.0/npm11.19.0, tsx4.23.15, PGlite0.5.8, postgis0.2.8 and pgvector0.0.9. No new package or database server is needed.

```sh
export PATH=/home/perry/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin
cd /mnt/d/Projects/RPL

# Disabled by default: no database or model call.
npm run pipeline:local

# One bounded mock cycle; same state can be reopened after process restart.
npm run pipeline:local -- --enable --once --state demo-1

# Automatic local polling, finite run of 12 polls, every five seconds.
npm run pipeline:local -- --enable --watch --interval-ms 5000 --max-polls 12 --state demo-1

# Counts only; no source read or model invocation.
npm run pipeline:local -- --status --state demo-1

npm run pipeline:test
```

`pipeline:test` discovers all owned top-level literal cases and runs each in a fresh Node process. An initial combined run hit a native Node24 V8/WASM allocation assertion while repeatedly opening PGlite in one process; it was recorded as a failure. The isolated rerun passed27/27 with no automatic retries. Unsupported test declarations, child crashes, nonzero exits and interruption fail the runner. Use the registered command for aggregate verification.

To simulate a change during mock polling, edit the authored `tools/local-pipeline/fixtures/feed.json` body under the same report ID. That fixture is explicitly synthetic and contains no inferred geometry. The CLI accepts no network feed URL. State lives under ignored `.codex-build/local-pipeline/<state>`; keep it private and disposable. Each state is pinned to a synthetic namespace and model profile. Stop the process before removing its selected state directory; do not point this tool at an existing application database.

Create fresh disposable state if experimenting with an earlier unreviewed bootstrap draft. This local bootstrap is not a migration/repair interface for legacy application data. It refuses an existing unowned application schema and a different synthetic/model profile before applying canonical migrations.

Use one process per state directory. Stop a watch run before opening the same state for status or another cycle. The tests prove lease behavior within one local PGlite instance and sequential process restarts; they do not prove independent PostgreSQL sessions, simultaneous file-backed PGlite processes or hosted Neon concurrency.

## Separately opt-in real gateway probe

Routine checks use model doubles and do not read gateway credentials. The following command deliberately opts into the configured private gateway. It requires `NINEROUTER_URL`, `NINEROUTER_KEY`, and a stable nonsecret `NINEROUTER_CURATION_EPOCH` in ignored `.env.local`. Never paste those secrets into documentation or chat.

```sh
node --env-file=.env.local --import tsx tools/local-pipeline/run-local-pipeline.ts --enable --once --real-ai
```

This creates fresh isolated state, processes at most one authored report/AI attempt, and reserves at most three adapter HTTP attempts: extraction, embedding and reasoning. It does not run discovery, classification, planner actions, autonomous acquisition or automatic HTTP retries. Each provider request is limited to25seconds and each local model wait to26seconds. A failed stage remains pending for backoff in private state; the command does not wait and retry. Requested routes remain `Waspada-Jakarta` and `gemini/gemini-embedding-2-preview`; a curation epoch tags the configuration and does not pin the underlying weights.

The command prints its generated `real-<uuid>` state name. For a separately opt-in retry after backoff, add `--state real-<uuid>` to the same real command, keeping the original curation epoch. That resumes only the stored snapshot and at most one AI attempt; it does not collect the edited fixture or drain other jobs. To inspect counts without model calls, use `--status --real-ai --state real-<uuid>` instead of `--enable --once`. Reopening under a different model profile fails closed. A crash with a still-active lease waits for lease expiry and recovery backoff before another attempt.

No real gateway probe has been run for this new slice. Prior extraction timeouts at25 and45seconds remain an open gate; see [gateway testing](PRIVATE_AI_GATEWAY_TESTING.md). Real sources require documented access, reuse/retention and model-transfer terms. Human-reviewed quality evaluation, source authenticity, conflict resolution, spatial retrieval quality, hosted concurrency and the complete live pipeline remain separate gates.

## Actual acceptance evidence

In WSL Ubuntu-26.04: new pipeline27/27; existing web126/126, Worker516/516, DB45/45 test files and evaluation/AI36/36 passed. Full workspace/tool typecheck, Vite build, Wrangler dry-run and local UI/API smoke passed. The original combined `npm test` stopped at the native WASM crash; the unchanged regression suites were not repeated after isolating the new tool suite. The final isolated suite and build/smoke were run separately; this is not a claim that the original command passed.

Actual disabled CLI, finite two-poll mock watch, reopen/unchanged one-cycle and count-only status passed. Reopen retained exactly one snapshot, one completed ingestion job, one completed AI job and one private proposal. Tests cover A→B→A provenance, immutable snapshots, unrelated-job isolation, changed queued content, contradictory evidence/unknowns, pending AI collection, timeout/invalid-output retry, exhausted states, lease fencing, raw-error/credential exclusion and file-backed receipt replay after lost completion acknowledgement. Publication-related SQL tables remain empty on this path. Detailed commits, independent review and fixes are in [the delivery log](DELIVERY_LOG.md).
