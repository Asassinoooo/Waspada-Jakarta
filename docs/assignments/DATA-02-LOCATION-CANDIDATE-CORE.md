# DATA-02-LOCATION-CANDIDATE-CORE — bounded gazetteer phrase matcher

- **Status:** Assigned for local implementation
- **Backlog ID:** `DATA-02-LOCATION-CANDIDATE-CORE`
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch:** `work/DATA-02-LOCATION-CANDIDATE-CORE`
- **Worktree:** `.codex-build/worktrees/data-02-location-candidate-core`
- **Assigned base:** Pinned in the root dispatch and backlog after the assignment commit.
- **Requirements:** FR-03/04/06; NFR-01/05/07
- **Dependencies:** `DATA-02-CORE`, `L2-ADAPTER-01`, `GEO-STORE-CORE`
- **Contracts:** Existing `PreparedText`, `ExtractionResultRecord` place-ID/scope conventions, and source-supported `Geometry`; no persisted or public contract change.

## Objective

Implement a deterministic Layer 1 matcher that turns spans in already normalized, permission-screened report text into bounded place-ID candidates using a caller-supplied, dataset-scoped gazetteer snapshot. It provides an offline candidate-generation boundary while source-specific gazetteer selection and rights remain gated.

## Required behavior

1. Accept only a bounded prepared-text value with its report revision ID, dataset, exact text hash, and normalization version, plus an explicitly supplied gazetteer snapshot with its own dataset, ID, version, and bounded place/alias records. Reject cross-dataset input and malformed snapshot/text values with fixed error codes.
2. Perform case-insensitive token/phrase matching with Unicode-aware tokenization. Aliases match complete tokens, not substrings within a word. Return zero-based, end-exclusive Unicode code-point offsets into the exact supplied prepared text. Do not normalize or rewrite that text inside the matcher.
3. Bound text length, place count, total alias tokens, alias length/token count, and emitted matches before work can grow without limit. If the output limit is exceeded, return a fixed incomplete/unavailable outcome instead of a truncated candidate list.
4. Preserve ambiguity: if the same matched phrase maps to multiple place IDs, return all distinct IDs for that span in stable order. Keep overlapping short/long matches as separate candidates; do not rank, select, merge, or geocode them.
5. Return only dataset/revision/hash/normalization and gazetteer snapshot identity, code-point spans, and candidate place IDs. Do not return source text, aliases, coordinates, geometry, polygons, administrative boundaries, user relevance, event claims, public status, safety language, or risk radii.
6. Return no result for an unmatched phrase. It must not imply that the report has no location or that an area has no reports. A candidate is not a validated location; only separate evidence-backed L4 policy can authorize geometry or publication.
7. Use authored synthetic gazetteer entries only. No Jakarta name dataset, source download, database migration/grant, persistence, API/UI, scheduler, provider/model call, dependency, external service, or deployment change is in scope.

## Allowed paths

- `apps/worker/src/layers/l1-data-knowledge/location-candidates.ts` (new)
- `apps/worker/test/location-candidates.test.ts` (new; run directly without manifest changes)
- `docs/assignments/DATA-02-LOCATION-CANDIDATE-CORE-HANDOFF.md` (new)

Do not edit shared text preparation, extraction/database contracts, geometry storage, package manifests/lockfiles, migrations, public contracts, architecture, backlog, or other assignments. Ask root if an existing interface requires a contract change; continue the isolated matcher and tests where possible.

## Acceptance and verification

- Focused synthetic tests cover complete-token matching, phrase/punctuation handling, case behavior, Unicode code-point spans, nested overlaps, ambiguous aliases, deterministic ordering, empty matches, cross-dataset rejection, malformed snapshots, and every configured work/output limit.
- Tests prove the matcher does not select one ambiguous place, synthesize coordinates/geometry, return source text, or alter/persist data.
- In WSL Ubuntu-26.04 with existing dependencies, record Node/npm and relevant package versions. Run the focused Worker test directly, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Do not install packages or use Windows-host runtimes for verification.
- Work only on the assigned branch/worktree and exact pinned base. Commit implementation/tests and handoff separately. Do not merge or push. Root independently reviews and integrates accepted changes.

## Stop conditions

Stop and report to root if actual coordinates, boundary files, source-specific gazetteer rights, a database/API schema, or a model/provider are needed for the bounded matcher. Do not substitute invented or unofficial live location data. Do not escalate models for usage limits or scheduling delays.

## Root review and acceptance

Pending. Root will record independent review, checks, integration, and limitations here after handoff.
