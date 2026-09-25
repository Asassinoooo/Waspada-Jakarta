# L1-FIXTURE-PIPE-CORE — Synthetic queue-to-fixture processing

- **Status:** Ready for local implementation
- **Depends on:** JOB-01, ING-PARSE-01, DATA-02-CORE, GEO-STORE-CORE, L1-WRITE-IDEMPOTENCY-CORE
- **Requirements:** FR-02/03/13; NFR-01/05/07
- **Architecture:** Layer 1 processing; bounded L4 job lease acknowledgement
- **Branch/worktree:** `work/L1-FIXTURE-PIPE-CORE`; `.codex-build/worktrees/l1-fixture-pipe-core`
- **Owner:** GPT-6 Luna Max implementation agent; root plans and reviews

## Objective

Implement an injected, deterministic pipeline for an already-claimed synthetic moderator-submission job. It resolves only an exact URL in a local authored fixture catalog, parses the buffered GeoJSON fixture, joins each explicit synthetic feature ID to a caller-authored manifest, prepares the manifest's permitted text, then persists an immutable schema 2.0 report revision, evidence reference(s), chunks, and any explicitly mapped source geometry. The queue job is completed only after all required writes succeed. This is a local composition slice, not a source connector or a production worker loop.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` — FR-02/03/13, NFR-01/05/07 and five-layer ownership
- `docs/IMPLEMENTATION_BACKLOG.md` — JOB-01, ING-PARSE-01, DATA-02-CORE, GEO-STORE-CORE and L1-WRITE-IDEMPOTENCY-CORE
- `docs/DOMAIN_MODEL.md` — ReportRevision, evidence, geometry, time and dataset invariants
- `docs/assignments/JOB-01.md`, `ING-PARSE-01.md`, `DATA-02-CORE.md`, `GEO-STORE-CORE.md`, and `L1-WRITE-IDEMPOTENCY-CORE.md`
- `apps/worker/src/layers/l1-data-knowledge/petabencana-geojson.ts`, `text-preparation.ts`, and `evidence-chunking.ts`
- `apps/db/src/queue.ts`, `ports.ts`, `evidence-chunks.ts`, and `geometry-writer.ts`

## Required behavior

- Add a dependency-injected Worker L1 processor. It receives a job record already in `leased` state and accepts only `datasetKind === 'synthetic'`, `jobKind === 'moderator_submission'`, a null job `sourceId`, a non-null submitted URL, and a non-empty lease token. It does not call `claimDueJob`; that API has no dataset or job-kind filter. The isolated integration test may claim a job only after creating a fresh PGlite database containing exactly one due synthetic moderator-submission job.
- Resolve the submitted URL by exact equality in an injected in-memory `SyntheticFixtureCatalog`. The catalog returns already-buffered synthetic GeoJSON, a fixed caller-supplied `retrievedAt`, a pre-seeded synthetic `manual_fixture` source ID, and an explicit manifest keyed by the parser's synthetic feature ID. No `fetch`, URL redirect, filesystem read, timer, scheduler binding, `source_poll`, or environment lookup is allowed.
- Every manifest entry supplies a stable caller-owned `reportRevisionId`, exact synthetic source ID and canonical URL, valid schema 2.0 revision metadata, and authored `permittedText`. Do not derive stable IDs or `sourceRevisionKey` from parser/provider IDs. The canonical URL must equal the exact catalog URL. Keep `sourceCreatedAt`, `providerStatus`, and `reportType` as transient parser output: schema 2.0 has no approved durable fields for them. Never map `created_at` to `publishedAt`, `observedAt`, event time, or retrieval time, and do not add arbitrary keys to the closed ReportRevision JSON object.
- Run the existing deterministic text preparation and chunking functions. The manifest's geometry mapping, if present, supplies its semantic geometry role, precision basis, labels, geometry ID, and exact end-exclusive Unicode code-point support spans into the prepared permitted text. Persist only 2D geometry accepted by the existing Geometry contract; reject any 3D position rather than dropping altitude. Do not infer a geometry role, evidence span, point, route, hazard area, or radius from parser fields.
- Persist the revision with `revisionStatus: 'unreviewed'`, exact caller-authored metadata and parser-independent times; create the listed `supports` evidence references; persist chunks; and use the existing source-backed geometry writer for explicitly mapped geometry. Validate that the referenced synthetic source row uses `manual_fixture`, is approved, and has automatic acquisition and publication disabled. Do not update source health for moderator submissions.
- A valid empty FeatureCollection completes successfully with zero report/evidence/chunk/geometry writes and returns an explicit empty result; it must never emit an all-clear or safety conclusion. A malformed payload, unknown URL, invalid manifest, unsupported geometry, or persistence error returns a bounded stable code without including the URL, permitted text, raw JSON, provider values, or exception message in the queue failure code or result.
- Fail only with a typed, redacted failure code and the existing bounded queue disposition. Never complete before all writes. A lost/stale lease acknowledgement returns an explicit not-owned/lost outcome without overwriting job state. A retry after partial or complete writes must converge through stable revision IDs, natural evidence identities, deterministic chunk IDs, and geometry retries; exact persisted data must not change.
- Keep processing restricted to synthetic fixtures. Do not add schema/API/OpenAPI changes, database migrations or repository behavior, new dependencies, route wiring, source acquisition, model calls, generated data, publication/event writes, source activation, moderator authentication, cloud resources, credentials, live/history data, or paid services.

## Allowed paths

- `apps/worker/src/layers/l1-data-knowledge/synthetic-fixture-pipeline.ts` only for the processor
- `apps/worker/test/synthetic-fixture-pipeline.test.ts` and any authored fixture support under `apps/worker/test/**`
- `apps/worker/package.json` only to register the new Worker test
- `apps/db/test/synthetic-fixture-pipeline.test.ts` only for PGlite integration of the Worker processor with accepted DB repositories
- This assignment's implementation handoff only

The Worker processor must use injected structural interfaces; do not import DB runtime code into the Worker bundle or create a new workspace dependency. If the package boundary prevents the scoped integration test, stop and report the smallest required root decision rather than expanding the paths.

## Acceptance and checks

- Unit tests prove exact URL lookup, synthetic/moderator/leased-job guards, success ordering, explicit empty behavior, redacted parse/catalog/persistence failures, and refusal to coerce 3D geometry or infer roles/spans.
- PGlite integration under `SET ROLE waspada_l1_pipeline` proves one claimed synthetic submission persists a schema 2.0 unreviewed report, stable evidence reference, deterministic chunks, and only manifest-supported geometry before completion; the source remains manual-fixture with health/policy unchanged and no event/publication records appear.
- Prove empty input completes with no inserted records or all-clear value. Prove a stale lease cannot acknowledge, then recover and retry the same fixture to show stable IDs, one revision/evidence identity/chunk set/geometry and unchanged first trace. State clearly that single-session PGlite does not prove hosted multi-session behavior.
- In WSL Ubuntu-26.04 run `npm test --workspace=@waspada/worker`, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Use Node.js `v24.21.0` / npm `11.19.0`; avoid building concurrently with PGlite tests.
- Commit implementation and handoff separately on the assigned branch, leave a clean worktree and report exact commits, paths, behavior, checks and limitations. Do not push or merge.

## Handoff

### Implementation report

- **Branch/worktree:** `work/L1-FIXTURE-PIPE-CORE` — `.codex-build/worktrees/l1-fixture-pipe-core`
- **Implementation commit:** `01c9bac465b3839f16b7efe50b20fadab7159d3d` — `feat(L1-FIXTURE-PIPE-CORE): process synthetic moderator fixtures`
- **Handoff commit:** `docs(L1-FIXTURE-PIPE-CORE): record implementation handoff` (SHA is reported by the implementer with the branch handoff.)
- **Changed paths:** `apps/worker/src/layers/l1-data-knowledge/synthetic-fixture-pipeline.ts`, `apps/worker/test/synthetic-fixture-pipeline.test.ts`, `apps/worker/package.json`, and `apps/db/test/synthetic-fixture-pipeline.test.ts`.
- **Behavior:** Added an injected exact-URL in-memory fixture catalog and a processor for already-leased synthetic moderator-submission jobs. It constructs only closed schema 2.0 unreviewed revisions from manifest-authored fields, keeps parser metadata transient, runs deterministic text preparation/chunking, persists explicit supporting spans and manifest-mapped 2D geometry, checks the synthetic source's manual-fixture approval/policy, and acknowledges the job after writes. Empty collections complete explicitly without record writes. Parse, catalog, source, persistence, and acknowledgement failures return fixed redacted codes; lost leases and uncertain completion acknowledgements never trigger an unsafe second transition. Feature IDs are lookup keys only and never become persisted identifiers.
- **WSL runtime:** Ubuntu-26.04, Node.js `v24.21.0`, npm `11.19.0`.
- **Checks:** `npm test --workspace=@waspada/worker` passed **62/62**. The new PGlite composition test passed **1/1** under `SET ROLE waspada_l1_pipeline`; root also verified each of the eight DB test files individually, including the new integration file. `npm run typecheck` and `npm run build` passed. Staged `git diff --check` passed. `npm run db:test` exited 1 without a test summary; root's serialized retry reported `Could not find ''` before running tests. Aggregate `npm test` passed web **5/5** and Worker **61/61** at that run, then the DB test runner exited 1 after its first suite without a failure summary. The aggregate DB-runner issue remains unresolved, so it is not reported as passing.
- **Migration/configuration impact:** None. No schema, API, migrations, dependencies, runtime bindings, or deployment configuration changed. The Worker package script only registers the new test.
- **Limitations:** The processor consumes authored synthetic fixtures only; it performs no source acquisition and has no Worker route or scheduler wiring. PGlite is a single-session local test and does not establish hosted multi-session transaction behavior. Individual DB test files pass, but the aggregate DB runner still needs diagnosis.
- **Remaining decisions:** None for this bounded implementation. Root review and acceptance are pending.
