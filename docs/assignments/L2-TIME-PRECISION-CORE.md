# L2-TIME-PRECISION-CORE — Compare RFC3339 intervals at full precision

- **Status:** Accepted on `main` at root merge `93f8aae`; implementation and handoff details are recorded in [the handoff](L2-TIME-PRECISION-CORE-HANDOFF.md)
- **Agent:** GPT-6 Luna / max
- **Branch:** `work/L2-TIME-PRECISION-CORE`
- **Worktree:** `C:\Users\perry\.codex\worktrees\l2-time-precision-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/l2-time-precision-core/RPL`)
- **Base:** Root dispatch commit; exact SHA is supplied in the assignment message and must appear in the handoff
- **Dependencies:** L2-ADAPTER-01, L2-PROPOSAL-REASONING-BRIDGE-CORE
- **Requirements:** FR-05/06; NFR-01/07
- **Contracts:** Existing typed L2 time scopes and validity periods; no schema or API change

## Objective

Correct the shared Layer 2 output parser's interval ordering. `validation.ts` currently uses millisecond-resolution `Date.parse` to compare timestamps that may contain up to nine fractional-second digits. As a result, a truly reversed interval such as `2026-10-01T10:00:00.123456Z` to `2026-10-01T10:00:00.123455Z` can pass when both values parse to the same millisecond. The reasoning proposal bridge now correctly reuses that shared parser, so fix ordering at the shared validation boundary rather than adding another bridge-local timestamp parser.

Preserve the exact input timestamp strings and the current comparison semantics: exact and range event-time scopes reject only when the end instant is earlier than the start; validity periods remain end-exclusive and reject when `validFrom` is equal to or later than `validUntil`. Date-only comparisons keep their current UTC-midnight interpretation. Account for all accepted fractional precision and numeric UTC offsets when comparing instants. Do not silently normalize timestamps or change schema semantics.

## Allowed paths

- `apps/worker/src/layers/l2-model-grounding/validation.ts`
- `apps/worker/test/l2-model-grounding.test.ts`
- `docs/assignments/L2-TIME-PRECISION-CORE-HANDOFF.md`

Root owns this assignment, the backlog, SDP, and ADRs. Do not change public contracts, APIs, schemas, database code, model prompts, providers, dependencies, source access, publication behavior, or runtime bindings. Stop and report any mismatch requiring those paths.

## Acceptance and verification

Use authored synthetic values and the existing typed model adapter tests. Cover a sub-millisecond reversed exact interval and range interval being rejected; valid increasing values with six and nine fractional digits; offset-equivalent instants comparing equal; exact timestamp text remaining unchanged in accepted results; date-only ordering; and the validity period's strict end-exclusive boundary. Malformed timestamps must continue to fail with stable content-free validation errors. Do not claim improved factual or model quality.

Run in WSL Ubuntu-26.04 with existing dependencies and Node 24.21.0/npm 11.19.0. Run the focused L2 parser tests, the bridge focused test, full `npm test`, `npm run typecheck`, `npm run build` (Vite and Wrangler dry-run only), and `git diff --check <assigned-base>..HEAD`. Record exact counts, runtime versions, limitations, branch, worktree, commit SHAs/messages, and remove any temporary dependency link before handoff. Root performs independent review and sets acceptance.
