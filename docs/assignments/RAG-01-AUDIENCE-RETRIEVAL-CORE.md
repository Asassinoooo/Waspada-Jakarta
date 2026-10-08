# RAG-01-AUDIENCE-RETRIEVAL-CORE — Audience-aware internal evidence retrieval

- **Status:** Assigned for local synthetic implementation
- **Depends on:** RAG-CORE, RAG-ACCESS-01, L1-EXTRACTION-RESULT-PERSIST-CORE, ADR-053
- **Requirements:** FR-04/05/06; NFR-01/05/07
- **Architecture:** Layer 2 retrieval only
- **Branch/worktree:** work/RAG-01-AUDIENCE-RETRIEVAL-CORE; .codex-build/worktrees/rag-01-audience-retrieval-core
- **Contracts:** ExtractionResult schema 2.0 and GroundingContext schema 2.0 unchanged; internal retrieval result reports hybrid-evidence-v2 for repository searches
- **Owner:** GPT-6 Luna Max implementation agent; root plans and reviews

## Objective

Extend the existing deterministic Layer 2 retrieval query to find evidence candidates whose persisted extraction scope exactly matches a bounded caller-supplied audience ID. This supports non-geographic group notices without making audience scope itself evidence or a publication claim.

## Read first

- AGENTS.md
- SOFTWARE_DEVELOPMENT_PLAN.md
- docs/IMPLEMENTATION_BACKLOG.md
- docs/DOMAIN_MODEL.md
- docs/decisions/ADR-011-l2-grounding-reader.md
- docs/decisions/ADR-015-l2-grounding-context-persistence.md
- docs/decisions/ADR-025-exact-live-briefing-runtime.md
- docs/decisions/ADR-049-l2-grounding-context-resume.md
- docs/decisions/ADR-053-audience-evidence-retrieval.md
- docs/assignments/RAG-CORE.md
- docs/assignments/RAG-ACCESS-01.md
- docs/contracts.schema.json
- apps/db/src/evidence-retrieval.ts
- apps/db/test/evidence-retrieval.test.ts
- apps/db/migrations/004_l2_grounding_reader.sql

## Scope and behavior

- Add an optional audience-ID list to the internal EvidenceRetrievalQuery and matched audience IDs to each internal candidate's matchFacets.
- Validate the list as exact bounded IDs, deduplicate it, and cap it at 20. Match only exact ID intersection with the persisted extraction record's scope.audience_ids. Do not translate labels/names or use fuzzy matching.
- Include audience-only matches even when the query has no exact terms, time bounds, geometry, or semantic vector. Rank deterministically using ADR-053. Do not collapse, omit, or rewrite any linked evidence relation or source/origin lineage.
- Defensively parse persisted scope. Missing, malformed, or non-array audience data must not create a match; other valid query facets must still work.
- Advance the internal retrieval version to hybrid-evidence-v2 so newly persisted GroundingContext records identify the changed retrieval behavior. Do not change the GroundingContext schema or persist audience query IDs.
- Keep this input inside Layer 2 retrieval. Do not connect browser-local preferences or the public briefing path; do not add telemetry fields, a route, UI, public response field, model call, L3 action, publication, or provider.
- Use authored synthetic fixtures only. Candidate scope is not independently bound to a particular evidence span, so audience matches are discovery hints only. No factuality, sufficiency, recall, safety, or publication-eligibility claims are authorized.

## Contracts and compatibility

ExtractionResult and GroundingContext remain schema 2.0. The retrieval TypeScript query/result is internal and may gain the described facet. No migration or grant change is allowed: migration 004 already grants the L2 reader access to extraction_results.record_json. If any new privilege or schema field appears necessary, stop and report the exact gap.

## Allowed paths

- apps/db/src/evidence-retrieval.ts
- apps/db/test/evidence-retrieval.test.ts
- apps/db/test/rag-grounded-proposal-roundtrip.test.ts
- apps/db/test/manual-publication-gate-composition.test.ts
- apps/worker/test/l2-evidence-retrieval.test.ts
- apps/worker/test/l2-grounding-context.test.ts
- apps/worker/test/l4-manual-publication-service.test.ts
- apps/worker/test/l4-publication-policy.test.ts
- This assignment's implementation handoff section only

Do not change migrations, schema contracts, Worker production adapters, API/OpenAPI, public projections, telemetry, packages, configuration, other assignments, or architecture files. The listed tests are allowed only for updating internal candidate/result fixtures and assertions needed by the new required facet and version; do not broaden their scenarios. Root owns the plan, ADR, backlog and checkpoint. The typed internal retrieval result may use an explicit version union or a string identifier, but every result produced by the SQL repository must report hybrid-evidence-v2. Update the grounded proposal roundtrip assertion to prove that version reaches the persisted schema 2.0 GroundingContext. Existing stored v1 contexts remain immutable and are resumed by exact references; this task does not rewrite them or repeat their original search.

## Acceptance and checks

- An audience-only synthetic query returns the expected linked evidence candidate without geometry, exact terms, time bounds, or a vector.
- Exact matches, non-matches, deduplication, bounds, deterministic order, dataset isolation, contradictions, and truncation are covered.
- Malformed persisted audience scope cannot match but does not break a separate exact-term query for the same candidate.
- The real SQL query passes under SET ROLE waspada_l2_grounding_reader; prove audience scope remains readable without widening the existing role.
- Match facets do not alter evidence relations, provenance, timestamps, offsets, or candidate-only semantics.
- The retrieval version is hybrid-evidence-v2 on normal and empty SQL-repository results and reaches a newly persisted context in the existing roundtrip test.
- No user preference, raw audience text, or location enters telemetry or a public response.
- In WSL Ubuntu-26.04 run the focused retrieval tests, npm run db:test, npm test, npm run typecheck, npm run build, and git diff --check <assigned-base>..HEAD.
- Commit all assigned implementation and handoff changes on the task branch in coherent descriptive commits. Do not push or merge.

## Stop conditions

Stop and report to root if the existing role or schema cannot support the query, if a public/persisted contract change is required, or if the task would need real source data, personal user interests, an external provider, or an unapproved dependency. Do not widen scope or escalate models unless a Luna/max implementation attempt reaches a substantive technical impasse.

## Implementation handoff

The implementation agent appends branch/worktree, exact base, commit SHAs and messages, changed paths, behavior, checks actually run, limitations, migration/configuration impact, and remaining decisions. Root independently reviews and accepts the branch.
