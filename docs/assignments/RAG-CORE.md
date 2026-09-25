# RAG-CORE — Deterministic hybrid evidence retrieval

- **Status:** Planned; local synthetic implementation only
- **Depends on:** DATA-01, DATA-02-CORE, L2-ADAPTER-01
- **Requirements:** FR-05, FR-06, FR-07; NFR-01, NFR-07
- **Architecture:** Layer 2 retrieval and grounding; no Layer 3 orchestration
- **Branch/worktree:** To be assigned after DATA-02-CORE acceptance
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

## Explicit exclusions

No live source, real model/embedding provider, EVAL-01 labels, scoring thresholds calibrated to safety quality, publication, L3 tool execution, source approval, API/OpenAPI/UI route change, database migration, new dependency, cloud account, credential, paid service, or deployment.

## Allowed paths

The branch and exact allowed paths will be added when this package is assigned. The implementation may touch the Layer 2 retrieval module and typed DB repository/query tests required for its accepted output boundary. Root owns architecture, backlog, and other plans. Do not change public contracts or schema without an explicit root scope update.

## Acceptance and checks

- Retrieved evidence is grounded in existing persisted rows and exact source text spans. Provenance and contradictions survive retrieval and serialization.
- Retrieval remains deterministic, dataset-scoped, bounded, and separate from model inference and investigation orchestration.
- Test data does not support claims about real-world retrieval quality. Record that limitation in the handoff.
- Run `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` in WSL Ubuntu-26.04. No smoke test is needed unless a runtime route is explicitly assigned.

## Implementation handoff

The implementation agent appends its branch/worktree, commit SHAs/messages, changed paths, exact checks, limitations, and any scope issue after DATA-02-CORE has been accepted and root has confirmed the boundary.
