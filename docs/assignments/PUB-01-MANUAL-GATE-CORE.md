# PUB-01-MANUAL-GATE-CORE — Layer 4 policy-to-writer composition

**Status:** Assigned; local synthetic composition only<br>
**Backlog ID:** `PUB-01-MANUAL-GATE-CORE`<br>
**Parent:** `PUB-01`<br>
**Dependencies:** `PUB-POLICY-CORE`, `PUB-WRITE-CORE`, `L2-PROPOSAL-PERSIST-CORE`, `L2-PROPOSAL-REASONING-BRIDGE-CORE` (accepted)<br>
**Contract baseline:** Publication policy input/result, schema 2.0 `EventProposal`, and `PublicationWriteCommand`; use existing migration 005 grants, with no schema or migration change<br>
**Implementation model:** GPT-6 Luna, max reasoning<br>
**Branch:** `work/PUB-01-MANUAL-GATE-CORE`<br>
**Worktree:** `.codex-build/worktrees/pub-01-manual-gate-core`<br>
**Assigned base:** Pinned by root in the task dispatch before implementation.

## Objective

Close the local Layer 4 composition gap between the existing deterministic publication policy and atomic publication writer. The service must load the canonical persisted proposal by identifier through a strict L4-scoped reader, re-evaluate its exact current evidence and an explicit trusted moderator decision, then construct the writer command itself. A proposal object supplied by the caller is never authoritative. This is not the full PUB-01 release: no route, authenticated review interface, automatic publication, provider, source access, rights claim, quality claim, or change to the read-only demo is permitted. Source-backed evaluation remains gated by EVAL-01.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` (especially Layer 4 and PUB-01)
- `ARCHITECTURE.md` (publication boundary)
- `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/assignments/PUB-POLICY-CORE.md`
- `docs/assignments/PUB-WRITE-CORE.md`
- `docs/assignments/L2-PROPOSAL-REASONING-BRIDGE-CORE.md`
- `apps/worker/src/layers/l4-application-integration/publication-policy.ts`
- `apps/db/src/event-proposals.ts`
- `apps/db/src/publication-writer.ts`
- `apps/worker/test/l4-publication-policy.test.ts`
- `apps/db/test/publication-writer.test.ts`
- `apps/worker/package.json`

## Required behavior

1. Add an internal `EventProposalReader` and SQL adapter in the DB package. It accepts only an exact live `proposal_id`, reads `record_json` through the already-granted `waspada_l4_publication_writer` capability, validates it with the existing strict schema-2.0 proposal validator, and verifies its dataset, proposal, trace, candidate, context, event and base-version columns agree with that validated record. Return `null` for absence and a fixed storage/validation error for malformed or mismatched persisted data. Add PGlite coverage under the existing L4 writer role; do not add a grant or migration.
2. Add an internal typed Layer 4 service that accepts a proposal identifier, the current policy inputs (including the current RAG result, current remit/freshness state, target version, and moderator decision), explicit moderator-reviewed event/impact drafts, and bounded write metadata. It must load the proposal only through the injected reader. Inject the existing writer through a narrow `publish(PublicationWriteCommand)` port.
3. Recompute `assessPublicationPolicy` inside the service using only the reader-returned proposal. Do not accept a caller-provided proposal, policy assessment or prebuilt writer command as authority. Do not call the writer unless the overall policy disposition and every claim disposition are `publish`, the moderator action is explicit `approve`, and `trustedCallerAuthorized` is true. Every denied or mismatched path returns a stable, content-free result and makes zero writer calls.
4. Before assessment can authorize a write, fail closed unless the persisted proposal and policy input agree on dataset, trace, candidate, context, target event/version, claim count and order, claim text/time/validity/scope/qualifiers, every support/contradiction/context evidence reference, support assessment, unresolved fields, and conflicts. Require the schema-2.0 bridge's stable claim IDs and `under_review` evidence labels; do not infer or elevate a source label. Compare reasoning model-run metadata where representable in both contracts; the canonical proposal intentionally does not store provider identity.
5. Construct the write command internally. Bind it to the exact proposal and target, copy the already-authorized actor/time/reason from the explicit decision, map each claim by the canonical proposal's stable order, and preserve all policy-matched support, contradiction, and context references with their exact revision/hash/span/offset/relation. Require the reviewed event/impact draft versions to match the policy target and include only claims allowed by the policy. Let the existing atomic writer enforce transaction-time versions, stored lineage, idempotency, append-only records, and outbox behavior.
6. New-event and update/correction proposals use this same gate, regardless of whether their `investigation_id` is absent or present. Model confidence, JSON validity, RAG sufficiency alone, and a synthetic dataset marker never authorize publication. No thresholds or automatic path are introduced.
7. Keep this module unreachable from HTTP routes and scheduled handlers. Do not change the demo's read-only moderator UI or configure an identity provider. The service is a protected internal capability for a future trusted L4 caller; authorization remains supplied by that trusted boundary.
8. Use only authored synthetic/live-shaped fixture values and fake writer ports. Such fixtures do not represent real events, sources, rights, reviewer identities, or labels. Do not alter schemas, migrations, APIs/OpenAPI, routes, UI, dependencies, source/model adapters, cloud configuration, or any live service.

## Allowed paths

- `apps/worker/src/layers/l4-application-integration/manual-publication-service.ts` (new)
- `apps/worker/test/l4-manual-publication-service.test.ts` (new)
- `apps/worker/package.json` (test registration only)
- `apps/db/src/event-proposals.ts`
- `apps/db/test/event-proposal-reader.test.ts` (new)
- This assignment's implementation handoff only

Root owns architecture, backlog status and root acceptance records. If the accepted proposal and policy contracts cannot be bound exactly without changing a schema or public contract, stop and report the precise gap; do not weaken matching or add a bypass.

## Acceptance and verification

- PGlite tests prove the reader returns only the strictly validated stored live proposal, rejects row/JSON identity mismatches and malformed records, returns null for missing IDs, and is usable under only the existing L4 writer role.
- Tests prove the same service gate handles direct and investigated proposal records and both new/update targets, and that a caller cannot substitute forged proposal content under a persisted proposal ID.
- Tests cover exact proposal/context/retrieval/evidence alignment; explicit authorization and moderator approval; synthetic, missing, disputed, stale, malformed and mismatched cases; zero writer calls on every non-publish result; exact generated writer-command allowlist and evidence relations; and propagation of success, idempotent replay and writer conflicts.
- Tests assert no model/provider/source/network/database call is made by the service itself, no raw proposal/source content appears in errors, and no route/runtime registers the new operation.
- In WSL Ubuntu-26.04 with existing dependencies, record Node/npm versions and run the focused service tests, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Do not install dependencies or invoke external services.
- Work only in the assigned branch/worktree. Commit implementation/tests and the completed handoff separately with descriptive messages; leave the worktree clean. Do not merge or push. Root independently reviews and accepts.

## Stop conditions

Stop and report if the existing L4 role cannot perform the required persisted-proposal read, so a new database role/grant/migration would be required; or if this service needs an API/schema change, authenticated route, source/provider integration, real evidence/rights, or a user policy decision. Do not claim publication readiness or source-backed quality from synthetic tests.

## Implementation handoff

The implementer records branch/worktree and assigned base, commit SHAs and exact messages, changed paths, behavior, actual checks/results, limitations, migration/configuration impact, and remaining decisions here. Root performs independent review and acceptance.
