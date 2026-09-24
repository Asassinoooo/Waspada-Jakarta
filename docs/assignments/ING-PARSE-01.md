# ING-PARSE-01 — PetaBencana GeoJSON fixture parser

- **Status:** Ready for local implementation
- **Depends on:** SPEC-01, DATA-01
- **Requirement coverage:** FR-02/03; NFR-07
- **Branch/worktree:** `work/ING-PARSE-01-petabencana-fixtures`; `D:\Projects\RPL\.codex-build\worktrees\ing-parse-01` (`/mnt/d/Projects/RPL/.codex-build/worktrees/ing-parse-01` in WSL)
- **Owner:** GPT-6 Luna Max implementation agent; root plans and reviews

## Objective

Implement a deterministic Layer 1 parser for PetaBencana-style GeoJSON using only clearly synthetic, local fixtures. Parsing must preserve supported source-provided facts and geometry while keeping observation time, retrieval time, and provider status distinct. This is parser groundwork, not a collector or evidence verification result.

## Read first

- `SOFTWARE_DEVELOPMENT_PLAN.md` — FR-02/03, NFR-07, and five-layer separation
- `docs/IMPLEMENTATION_BACKLOG.md` — ING-PARSE-01, ING-01, and EVAL-01
- `docs/SOURCE_FEASIBILITY.md` — PetaBencana schema observations, attribution, rights, and empty-feed semantics
- `SOURCE_VERIFICATION_PLAN.md` — source provenance and report-versus-claim rules
- `docs/DOMAIN_MODEL.md` and `apps/db/src/ports.ts` — timestamps, dataset boundaries, report revision shape
- `ARCHITECTURE.md` — Layer 1 boundaries

## Required behavior

- Add a pure parser under `apps/worker/src/layers/l1-data-knowledge/`; it receives already-buffered JSON text and a caller-supplied retrieval timestamp. It performs no network, file, database, model, or geocoding operation.
- Parse a bounded GeoJSON `FeatureCollection` and return a typed result that distinguishes valid empty input, valid records, and malformed/unsupported input. Empty results are never an all-clear signal.
- Preserve only explicit provider fields supported by the parser contract (for example a feature key, provider-reported status/type, and `created_at`). Treat `created_at` as the source observation/creation timestamp only where valid; keep `retrieved_at` separate. Missing or invalid source time remains unknown and must not be replaced with retrieval time.
- Preserve geometry only when it is present and valid in the source feature. Accept only the GeoJSON geometry kinds needed by the contract and validate finite WGS84 longitude/latitude bounds. Do not create circles, radii, polygons, Jakarta boundaries, or map precision claims.
- Bound input size, feature count, nesting/coordinate work, and returned error details. Do not echo raw payload text into logs/errors. Reject malformed structures deterministically without silently dropping invalid features or coercing untrusted values.
- Fixtures must be plainly labelled synthetic and must not resemble an assertion about a current incident. No fetched or copied provider content.
- Add tests for empty `FeatureCollection`, multiple synthetic features, supported source geometry, invalid coordinates, missing/invalid `created_at`, duplicate or absent feature IDs, wrong top-level type, malformed/oversized JSON, and preservation of retrieval time separately from source time.

## Boundaries and checks

- **Allowed paths:** `apps/worker/src/layers/l1-data-knowledge/**`, `apps/worker/test/**`, and this assignment's handoff section.
- **Forbidden:** API/OpenAPI/domain schema changes, `apps/db/**`, source registry activation, any HTTP client/fetch, live or copied source data, raw payload logging, model calls, new dependencies, provider resources, credentials, or deployment.
- No human labels are required for parser contract tests. Do not infer source accuracy, real-world completeness, or safety from synthetic tests.
- Use WSL Ubuntu-26.04 and native Node.js/npm from `docs/BOOTSTRAP.md`. Run `npm test --workspace=@waspada/worker`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` from the assigned worktree. This parser adds no route, so no smoke test is expected; explain if that boundary changes.
- Commit coherent work on the assigned branch and leave it clean. Do not push or merge.

## Handoff

Implementation agent appends branch/worktree, commit SHA(s) and exact messages, changed paths, actual checks and results, limitations, and any contract impact. Root independently reviews before acceptance.
