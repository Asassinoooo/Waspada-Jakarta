# RAG-CORE — Deterministic hybrid evidence retrieval

- **Status:** Assigned for local synthetic implementation
- **Depends on:** DATA-01, DATA-02-CORE, L2-ADAPTER-01
- **Requirements:** FR-05, FR-06, FR-07; NFR-01, NFR-07
- **Architecture:** Layer 2 retrieval and grounding; no Layer 3 orchestration
- **Branch/worktree:** `work/RAG-CORE-hybrid-retrieval`; `.codex-build/worktrees/rag-core`
- **Owner:** GPT-6 Luna Max implementation agent; root plans and reviews

## Objective

Build a local, deterministic retrieval boundary that returns candidate evidence from persisted report revisions and chunks using exact, temporal, spatial, and optional semantic signals. The output must retain source provenance, report state, origin dependence, and contradictory evidence so the later grounding step can inspect what the system found. Use synthetic records and fixed test vectors only.

## Read first

- `SOFTWARE_DEVELOPMENT_PLAN.md` — FR-05/06/07 and NFR-01/07
- `docs/IMPLEMENTATION_BACKLOG.md` — RAG-CORE and RAG-01
- `docs/DOMAIN_MODEL.md` — immutable evidence, origin lineage, geometry and revision states
- `docs/decisions/ADR-003-domain-publication-evidence.md`
- DATA-01, DATA-02-CORE, and L2-ADAPTER-01 assignments
- `apps/worker/src/layers/l2-model-grounding/contracts.ts`
- `apps/db/migrations/001_foundation.sql`

## Required behavior

- Accept a bounded, typed query and an optional already-computed query vector. Do not call an embedder, classifier, reasoner, geocoder, source connector, or L3 tool.
- Retrieve evidence using separate, inspectable facets: exact identifiers/terms where available, report and event time bounds, intersection with caller-supplied source-supported geometry, and semantic distance only for matching model/version/dimension/index metadata. Do not invent a radius, location, timestamp, or embedding. Missing query-vector capability must not suppress exact/time/spatial candidates.
- Keep every result bound to dataset, report revision, immutable permitted-text hash, chunk hash, exact code-point offsets, source, and distinct `published_at`, `observed_at`, and `retrieved_at` values. Include revision status and source/origin provenance.
- Preserve `supports`, `contradicts`, and `context` evidence separately. Record known copied/quoted/dependent origins as dependent and unknown lineage as unknown; never count one known underlying origin as multiple independent corroborations. Similarity is not proof of origin dependence.
- Enforce hard result/scan bounds and deterministic tie-breaking. Return match facets and version metadata rather than an uncalibrated confidence score.
- Return candidate evidence only. Do not set `GroundingContext.sufficient=true`, claim adequate coverage/recall, create a claim/proposal, or trigger investigation. Human-adjudicated evaluation is a separate gate under EVAL-01/RAG-01.
- Add PGlite tests with synthetic reports, geometries, origins, contradictory evidence, lifecycle/status variations, and fixed vectors. Verify dataset isolation, all retrieval facets, vector/hash/dimension/version binding, explicit handling of missing vectors, source-time separation, conflict retention, deterministic bounds/order, and copied-origin treatment. Label all test vectors and fixture rows synthetic.

## Implementation boundary and decisions

- Treat this as a read-only Layer 2 search of persisted `extraction_results`, `extraction_evidence`, `evidence_references`, immutable report revisions, source registry state, geometry evidence, origin lineage, and optionally active chunks/embedding vectors. The input is a bounded, already-validated candidate/query plus optional caller-supplied source-supported geometry and already-computed query vector. Do not run classification, extraction, embedding or reasoning here.
- Return a module-local candidate-search result with the matched evidence references, exact span text, relation, report/source state, distinct source timestamps, source-supported geometry matches, origin independence/dependency, match facets, and retrieval/index versions. Keep relation values as stored. Do not reinterpret a source relation as proof of support or contradiction for a different candidate.
- Keep `GroundingContext` persistence and proposal construction for RAG-01. Do not set or infer sufficiency, completeness, confidence, recall, truth, event identity or publication eligibility. No investigation or tool call is triggered by a search result.
- A candidate is included when it matches at least one requested non-empty facet; rank deterministically using exact identifier/term match, temporal and spatial matches, compatible semantic distance, then stored timestamps and stable IDs. The result must expose each actual match facet and truncation/omission indicators so callers cannot read an empty or capped result as proof of safety or absence.
- Spatial comparison may use only the caller's bounded CRS84 geometry and persisted geometries linked to the same evidence reference. Use exact intersection; never buffer, geocode or invent geometry. Return identifiers/roles/precision metadata needed to inspect the match.
- Include all revision states and source registry states in results unless an exact caller filter is applied. Preserve `published_at`, `observed_at`, and `retrieved_at` separately. Preserve recorded origins and direct dependency edges; if no origin is recorded, keep it unknown/absent rather than manufacturing an independent origin.
- Bound query strings/terms, geometry vertices, vector dimensions, candidate rows examined, result rows, and returned span text. Use deterministic tie-breaking. Only calculate semantic distance for the exact embedding identity requested and stored on an active chunk whose input hash matches; do not substitute a different vector identity. Exact/time/spatial matches remain available when no compatible vector exists.
- Use the existing database schema and injected SQL executor. Do not add a migration, role grant, public API/schema change, dependency, or provider configuration. If required reads cannot be exercised within the existing local repository boundary, stop and report the precise privilege/schema gap for root review; do not broaden access independently.

## Explicit exclusions

No live source, real model/embedding provider, EVAL-01 labels, scoring thresholds calibrated to safety quality, publication, L3 tool execution, source approval, API/OpenAPI/UI route change, database migration, new dependency, cloud account, credential, paid service, or deployment.

## Allowed paths

- `apps/worker/src/layers/l2-model-grounding/retrieval.ts`
- `apps/worker/test/l2-evidence-retrieval.test.ts`
- `apps/worker/package.json` — only to include the new test in the workspace test command
- `apps/db/src/evidence-retrieval.ts`
- `apps/db/src/ports.ts`
- `apps/db/test/evidence-retrieval.test.ts`
- This assignment's implementation handoff only

Root owns architecture, backlog, and other planning documents. Do not change public contracts, migrations, dependencies, lockfiles, model adapters, API routes, UI, or other assignments. If a new schema or privilege is necessary, stop and report the exact gap for root review.

## Acceptance and checks

- Retrieved evidence is grounded in existing persisted rows and exact source text spans. Provenance and contradictions survive retrieval and serialization.
- Retrieval remains deterministic, dataset-scoped, bounded, and separate from model inference and investigation orchestration.
- No result field claims sufficient evidence, quality, safety, truth, or independence beyond recorded origin metadata.
- Test data does not support claims about real-world retrieval quality. Record that limitation in the handoff.
- Run `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` in WSL Ubuntu-26.04. No smoke test is needed unless a runtime route is explicitly assigned.

## Implementation handoff

The implementation agent appends its branch/worktree, commit SHAs/messages, changed paths, exact checks, limitations, and any scope issue here.
