# LIFE-01-REPORT-REVISION-IMPACT-READER-CORE — find current published dependencies

**Status:** Accepted after independent root review; fast-forwarded to `main` through `cbe1db9623c2f7a49207e66edce58d219e4deb5b`.
**Backlog ID:** `LIFE-01-REPORT-REVISION-IMPACT-READER-CORE`
**Implementation model:** GPT-6 Luna, max reasoning
**Branch:** `work/LIFE-01-REPORT-REVISION-IMPACT-READER-CORE`
**Worktree:** Root creates a dedicated worktree from the exact local `main` commit named in dispatch.
**Contract baseline:** Schema 2.0 persisted event/evidence relationships and current public DTO/OpenAPI; no public contract change.

## Context and dependencies

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`, `docs/IMPLEMENTATION_BACKLOG.md`, ADR-005, ADR-020, ADR-028, ADR-032, ADR-038, ADR-042, and the accepted freshness-ledger and public-read-projection assignments/handoffs before editing.

`report_revisions`, evidence references, published claim/evidence links, and impact-to-claim links already preserve relational lineage. Published event versions and report revisions are immutable. ADR-042 requires keeping a current published version intact pending moderator review. The next Layer 4 workflow needs to identify the exact current published targets that cite one report revision before it can create any review state. This assignment is read-only discovery only: the caller supplies a report revision identifier whose source change has already been assessed elsewhere. The reader does not verify a retraction/revision status because there is not yet an append-only source-state ledger.

Dependencies: `LIFE-01-FRESHNESS-LEDGER-CORE`, `LIFE-01-FRESHNESS-READ-PROJECTION-CORE`, `DATA-01`, `DATA-02-CORE`, `DB-TEST-RUNNER-ISOLATION`, and ADR-005/020/028/032/038/042.

## Objective

Add an internal, bounded, least-privilege Layer 4 DB reader that maps one exact `(datasetKind, reportRevisionId)` to current published event claim-set targets supported by that revision and exact referenced impact versions that depend on those claims.

## Required behavior

1. Require an explicit `datasetKind` (`live`, `historical`, or `synthetic`), bounded report revision ID, page size from 1 to 100, and a validated optional keyset cursor. Never infer or combine dataset namespaces.
2. Match only evidence references for the exact dataset/revision where `relation = 'supports'`, linked to `event_claim_evidence.evidence_kind = 'support'`. Contradiction and context references do not make a published claim dependent on the revision for this reader.
3. Return one `event_claim_set` target for each exact current published event version with at least one matched claim. Exclude all older event versions and exclude the event entirely when its latest version is withdrawn or otherwise unpublished.
4. Return an exact `impact` target only when the impact version is referenced by that same current event version and `impact_claim_support` links it to at least one matched claim. Do not infer a relationship from title, geometry, proximity, or event identity alone.
5. Return only dataset/event/version and target-kind identifiers, plus exact impact ID/version for impact targets. Do not return claim IDs, report text, source URLs, evidence excerpts/references, hashes, complete rows/JSON, or model output.
6. Apply deterministic ordering and keyset continuation over `(event_id, event_version, target_kind, impact_id, impact_version)`. Apply the `limit + 1` probe after exact lineage/current-version filtering and return no more than the requested target count.
7. Query only through a dedicated read-only set of column grants for the existing `waspada_l4_freshness_writer` capability, or a narrower capability if the assigned-base ACL design requires it. Do not grant access to permitted source text or write/update/delete privileges. Prove current public/L1/L2/publication-writer access is not broadened.
8. Reject malformed and oversized inputs with stable content-free errors. Do not expose database errors, cursors, source content, or caller-supplied values.
9. Make no writes and no public behavior changes. Do not create freshness transitions, publication decisions, audit/outbox rows, moderator queue entries, source-state records, or source fetches. The current public event version, freshness, lifecycle, history, geometry, and API response remain unchanged by this reader.

## Allowed paths

- `apps/db/migrations/028_report_revision_impact_reader.sql` (new, least-privilege read capability only)
- `apps/db/src/report-revision-impact-reader.ts` (new)
- `apps/db/test/report-revision-impact-reader.test.ts` (new)
- `apps/db/test/migrations.test.ts` (migration inventory/order and role-access assertions only)
- `apps/db/test/public-event-updates.test.ts` (staged migration inventory/order expectation only)
- `docs/assignments/LIFE-01-REPORT-REVISION-IMPACT-READER-CORE-HANDOFF.md` (new)

Do not change Layer 1 ingestion or report-revision persistence, L2 retrieval/chunks/embeddings, freshness policy or ledger, publication code/data, current public views, API/OpenAPI/DTOs, UI, authentication, source adapters/providers, scheduler/outbox, dependencies, deployment configuration, or unrelated tests. Stop and ask root if the exact lineage cannot be queried with read-only column grants or if another path is required.

## Acceptance and verification

- Synthetic PGlite tests cover a single and multiple supported evidence references, unrelated revisions/datasets, contradiction/context exclusion, exact impact support mapping, older event-version exclusion, latest-withdrawn hiding, bounded page and stable cursor behavior.
- Tests prove output contains only exact public target identities, not claim/source content or complete rows, and that no publication, freshness, history, or outbox record changes.
- Run under the intended read capability; prove required narrow reads work, permitted source text is denied, and all writes are denied. Verify the migration does not broaden other roles.
- Test data is authored synthetic only. No source/provider/API is contacted. This reader does not establish that the input revision was actually retracted or superseded, or that any matched public claim is false.
- Run in WSL Ubuntu-26.04 with existing dependencies: focused reader/migration tests, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record actual results and versions; do not install dependencies or contact external services.
- Commit implementation and handoff separately on the assigned branch. Root independently reviews and integrates accepted commits; the agent does not merge or push.

## Stop conditions

Stop and ask root if the implementation would change a published event or public status, expose source content/claim details, create a write path, accept an unverified revision status as authority, contact a source, change a public contract, or grant source-text access. Do not add source-state transitions, freshness recording, moderator workflow, or runtime composition in this slice.
