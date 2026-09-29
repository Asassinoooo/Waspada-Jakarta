# RAG-RETRIEVAL-TIMESTAMP-RFC3339-CORE — emit valid RFC3339 evidence times

**Parent package:** RAG-CORE / FR-03 and FR-05
**Status:** Assigned for implementation on an isolated task branch
**Implementation model:** GPT-6 Luna, max reasoning
**Branch:** `work/RAG-RETRIEVAL-TIMESTAMP-RFC3339-CORE`
**Worktree:** Dedicated managed worktree from the full commit containing this assignment; do not edit in the root checkout.
**Contract baseline:** Existing `EvidenceRetrievalCandidate` and schema 2.0 `GroundingContext`/`ReasoningRequest`; no version or public API change.
**Dependencies:** RAG-CORE, RAG-CONTEXT-ASSEMBLY-CORE, L2-CONTEXT-PERSIST-CORE.

## Objective

Fix the Layer 1/DB-to-Layer 2 retrieval boundary so timestamps read from PostgreSQL can pass the existing strict Layer 2 grounding validator. PostgreSQL's default `timestamptz::text` format is space-separated (for example `2026-09-23 01:02:03+00`), while the validator requires RFC3339 with `T`. Normalize the database projection; do not weaken or duplicate the Layer 2 validation contract.

## Allowed paths

- `apps/db/src/evidence-retrieval.ts`
- `apps/db/test/evidence-retrieval.test.ts`
- `docs/assignments/RAG-RETRIEVAL-TIMESTAMP-RFC3339-CORE-HANDOFF.md`

Do not edit other production files, schemas/contracts, migrations, public APIs/OpenAPI, provider/source code, deployment configuration, dependencies, package scripts, or root-owned planning documents. If canonicalization would lose precision or otherwise fail to preserve the stored instant, stop and report the exact limitation.

## Required behavior

1. Return `publishedAt`, `observedAt`, `retrievedAt`, `validFrom`, and `validUntil` as RFC3339 date-times with a `T` separator and explicit timezone whenever the database value is non-null; preserve nullability for optional times.
2. Preserve the exact instant and available fractional-second precision when normalizing offsets to a canonical representation. Do not depend on the database session `TimeZone` setting.
3. Keep event-time values from the validated schema 2.0 extraction JSON unchanged; this task is limited to the relational report-revision timestamp columns.
4. Keep retrieval filtering/order semantics unchanged. Do not infer freshness, event lifecycle, source status, or sufficiency from normalization.
5. Add PGlite regressions for UTC and non-UTC offsets, fractional seconds, nullable optional times, and strict RFC3339 shape. Demonstrate that the repository result can be passed through the existing Layer 2 context-assembly/validation boundary without validator relaxation.

## Acceptance criteria

- Focused evidence retrieval tests prove the normalized values preserve the intended instants and fractional precision and are accepted by the current strict L2 validator.
- Existing time filtering, retrieval ordering, exact-span identity, provenance, and truncation behavior remain unchanged.
- No schema/API/migration/dependency/runtime change.
- WSL Ubuntu-26.04 checks pass: focused `apps/db/test/evidence-retrieval.test.ts`, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`.

## Stop conditions and handoff

If PostgreSQL formatting cannot retain precision without session-dependent behavior, or the existing L2 contract cannot accept a correct RFC3339 projection, stop and give root a reproducing fixture and exact boundary limitation. Do not coerce values in the integration-test mock or broaden the task into contract changes.

Commit coherent changes on this branch. Do not merge, push, configure external resources, or edit root-owned planning documents. The handoff must include branch/worktree, base, full commit SHA(s) and exact messages, changed paths, behavior, WSL commands/results, runtime versions, limitations, migration/configuration impact, and remaining decisions. Root owns independent review and integration.
