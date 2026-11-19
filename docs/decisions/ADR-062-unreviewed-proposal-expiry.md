# ADR-062 — Unreviewed proposals expire

- **Status:** Accepted on 12 November 2026 under REVIEW-EXPIRY-01. Builds on [ADR-061](ADR-061-agent-driven-publication.md). ADR-061 is otherwise unchanged.
- **Date:** 2026-11-12
- **Owner:** Team 12
- **Scope:** The proposal sweep (`expireStaleProposals` in `proposal-publication.ts`), the decision record it writes, the local live server poll loop, the Worker's scheduled handler (live only), the moderator queue, the pipeline flow view. Incident lifecycle, freshness, evidence status, source rights and the publication gate are unchanged.

## Context

ADR-061 queues a proposal for a moderator when it fails the automatic gate: a discrepancy, an unresolved correlation, a missing source right, or a missing location or time. Nothing removes a queued proposal that no moderator reviews. The queue grows, and a proposal from days earlier can still be approved and published against stale evidence.

## Decision

1. **Review window.** An undecided proposal older than the review TTL is marked expired. The TTL is the `PROPOSAL_REVIEW_TTL_HOURS` environment variable: an integer from 1 to 720, default 48. An unset or invalid value means 48. `parseProposalReviewTtlHours` in `publication-policy.ts` parses it. The raw value is never logged.
2. **Mark, do not delete.** `event_proposals` and `publication_decisions` are append-only (`reject_immutable_mutation` and `publication_decisions_append_only` triggers). `proposal_claims` and the decision rows reference the proposal through foreign keys. Deleting a proposal would need trigger and foreign-key changes and would lose the audit trail. A decision row keeps who decided, when and why, and it reuses the existing "already decided" rule. No migration is needed.
3. **Record shape.** One `publication_decisions` row per expired proposal:
   - `decision_id`: `dec-<uuid>`. `trace_id` and `proposal_id` come from the proposal. `policy_version`: `merge-review-v1`.
   - `event_id` and `event_version`: NULL. `reviewer_id`: `agent:review-expiry`. `decided_at`: the sweep time.
   - `record_json`: `{ disposition: "expire", actor_kind: "agent", actor_id: "agent:review-expiry", reason: "review_ttl_elapsed", ttl_hours, proposed_at, expired_at }`.
4. **The sweep never publishes.** It writes no event version, no claim and no `PublicReadModel` entry, and it touches no incident. Each run handles at most 50 proposals, oldest first. There is no per-incident dedupe, so every stale proposal is a candidate.
5. **When it runs.**
   - `serve:live` runs it at the end of each 60-second poll cycle, inside the existing `isPolling` guard.
   - The Worker's `scheduled()` runs it only when `DATASET_MODE` is exactly `live` and a database source is configured. Demo mode never runs it. `wrangler.toml` defines no cron trigger, so hosted expiry does not run until a trigger is added. That is a deployment gate.
6. **After expiry.**
   - A moderator publish or reject, and an agent auto-publish, of an expired proposal returns `already_decided`. The moderator endpoints answer 409.
   - The moderator queue (`readPendingProposals`) excludes it. The moderator UI has no decided or history list, so nothing else needs to hide it.
7. **Flow view.** The review node gets an `expired_24h` count, shown as the chip "kedaluwarsa N". Expired decisions are excluded from `decisions_24h`, `decisions_15m` and the gate's counts. In the proposal drill-down an expired item shows as "kedaluwarsa". The `pipeline-flow-v1` shape is unchanged: `counts` is already a generic record, so the new key is additive. A client that does not know the key ignores it.
8. **Meaning.** Expiry is not resolution, not a safety claim, and not a change to incident status, freshness or evidence state. A new report about the same incident creates a new proposal normally, and it is not blocked.

## Trade-offs and gates

- **Race with a moderator.** `publication_decisions` has no unique index on `(dataset_kind, proposal_id)`. A moderator decision and a sweep that land in the same instant can both write a row. This is accepted, as in ADR-061 under Concurrency. The fix would be an advisory transaction lock, as `persistProposalWithTx` already uses. It is a follow-up.
- **The by-ID route still returns an expired proposal.** `GET /api/v1/moderation/proposals/:id` reads any proposal by its id. Only the list hides it. Returning 404 for an expired proposal is a follow-up.
- **The drawer text is fixed.** The review node's description says "48 jam". If an operator sets another TTL locally, the text is stale. Passing the TTL into the flow snapshot is a follow-up.
- **Expired proposals can still be chained.** The intelligence chain head (ADR-061, rule 4) skips rejected and unresolved proposals, not expired ones. A new report on the same incident can therefore carry an expired proposal's never-reviewed claims into its own proposal. That proposal still goes through the normal gate. Excluding `expire` from the chain head is a one-line change in `apps/intelligence`, left for an owner decision because it changes correlation behaviour and is outside this task.
- **Hosted deployment is gated.** No cron trigger exists, and Neon and source rights are still gated, so hosted expiry does not run.

## Verification boundary

REVIEW-EXPIRY-01 is covered by these tests. They use PGlite and mocks, and make no network or model calls:

- `apps/db/test/proposal-expiry.test.ts`: the candidate query returns only undecided proposals older than the cutoff (49 h yes, 47 h no), decided proposals are excluded, the batch is capped at 50, rows carry no text, and the flow store reads an expiry as `expired_24h` and as "kedaluwarsa", not as a gate or publication decision.
- `apps/worker/test/review-expiry.test.ts`: TTL parsing and fallback, the decision record and no version or public change, moderator and agent refusal as `already_decided`, approved proposals never expired, a moderator reject that is not overridden, pending-queue behaviour, and the scheduled runtime (demo, unset `DATASET_MODE`, no database, and the TTL from the environment).
- `apps/worker/test/pipeline-flow-api.test.ts` and `apps/web/test/pipeline-flow-model.test.ts`: the review node carries `expired_24h`, the chip and drawer sentence show, and an older snapshot without the key shows no chip.

## Amendment 19 Nov 2026 (POLISH-03): a newer proposal supersedes older undecided ones

- **Status:** Accepted by the owner on 19 November 2026 under POLISH-03. Extends this ADR. Nothing in it is removed or changed except where listed here.
- **Context.** The moderator queue (`readPendingProposals`) already shows only the newest proposal per `incident_id`. In `#alur-agen` the older undecided proposals of that incident still counted as "menunggu" until the 48 hour expiry. The flow view then disagreed with the queue.

### Decision

1. **Disposition `supersede`.** When `persistProposalWithTx` (`apps/db/src/event-proposal-writer.ts`) writes a proposal that has an `incident_id`, every older undecided proposal of the same `dataset_kind` and `incident_id` gets one `publication_decisions` row:
   - `decision_id`: `dec-<uuid>`. `trace_id` and `proposal_id` come from the superseded proposal. `policy_version`: `merge-review-v1`. `event_id` and `event_version`: NULL.
   - `reviewer_id`: `agent:proposal-writer`. `decided_at`: the newer proposal's `proposed_at`, so the decision uses the pipeline's clock and is never earlier than the proposal it decides.
   - `record_json`: `{ disposition: "supersede", actor_kind: "agent", actor_id: "agent:proposal-writer", reason: "newer_proposal_same_incident", superseded_by: <new proposal_id>, incident_id, proposed_at, superseded_at }`.
2. **Older means** `(proposed_at, proposal_id)` is smaller than the new proposal's. This is the order the intelligence chain head uses. A proposal written with an earlier time than an existing undecided one does not supersede that one. The later-written, earlier-timed proposal stays undecided until expiry and stays hidden from the queue by the existing newest-per-incident rule, as before. Superseding it too is a possible follow-up.
3. **Same transaction.** The rows are written in the transaction that inserts the new proposal. Each candidate is locked with the per-proposal decision lock (the key `lockProposalDecisions` uses in `proposal-publication.ts`), then checked again for a decision. A decision that commits first wins, and the candidate is skipped. Candidates are locked in ascending order.
4. **Untouched.** Decided proposals are never touched. A proposal of another incident is never touched. A proposal without an `incident_id` supersedes nothing.
5. **Terminal and never published.** A superseded proposal is not revived when its replacement is rejected. A moderator or agent decision on it returns `already_decided` with disposition `supersede` (the existing rule, no change to `decideProposal`). The expiry sweep skips it, since it already has a decision row. The write creates no event version, claim, `PublicReadModel` entry or incident change. Superseded is not resolution, not a safety claim and not a change to freshness or evidence status.
6. **Flow view (`pipeline-flow-v1`, additive only).**
   - `supersede` is kept out of `decisions_24h`, `decisions_15m`, `moderator_decisions_15m` and the gate drill-down, as `expire` is.
   - It is counted as `publication.supersede_24h`, and the review node carries `supersede_24h` (chip "digantikan", drawer label "Digantikan versi baru 24 jam").
   - The proposal drill-down status is `supersede`, which the web model labels "digantikan versi baru". That is distinct from "kedaluwarsa".
   - The report-revision status `superseded` ("digantikan") is a different state and is unchanged.
7. **No migration.** `publication_decisions.record_json.disposition` has no CHECK constraint, so the new value needs no schema change.

### Trade-offs and follow-ups

- **Unresolved newer proposals also supersede.** An `unresolved` proposal carries the candidate incident's `incident_id`, so it supersedes too. This matches the queue's existing newest-per-incident rule, so no moderator view loses an item it showed before. The superseded claims are not carried into the unresolved proposal, which the correlator did not link.
- **Chain head.** The intelligence chain head skips only rejected and unresolved proposals, as ADR-062 notes for expiry. A superseded proposal can therefore be chained if its replacement is rejected. Excluding `supersede` from the chain head is an owner decision and is not part of this amendment.
- **Corrections.** `submitEventCorrection` inserts its own proposal and decides it in the same transaction. It does not go through `persistProposalWithTx`, so a correction does not supersede anything.
- **Grants.** The L2 proposal-writer role `waspada_l2_proposal_writer` has no INSERT or SELECT grant on `publication_decisions`. No runtime path that writes proposals or decisions sets that role (checked in `apps/worker/src` and `apps/intelligence/src`), so nothing breaks today. If that role ever runs `persistProposalWithTx`, the write fails and the whole proposal transaction rolls back, which fails closed. Granting it is a separate decision.
- **Index.** The candidate query matches `record_json->>'incident_id'` with no index, the same scan the chain-head query already does. An index needs a migration and is a follow-up.

### Verification boundary

- `apps/db/test/proposal-supersede.test.ts` (PGlite): writing B after undecided A supersedes A, once; a decided A is untouched; another incident is untouched; a proposal without `incident_id` supersedes nothing; an older proposal does not supersede a newer one; a repeated write adds no second row; the flow store reads the status `supersede`, the `supersede_24h` count, and no gate, publication or moderator-queue entry.
- `apps/worker/test/proposal-supersede.test.ts` (PGlite): a superseded proposal returns `already_decided` with disposition `supersede` for publish, reject and agent auto-publish, and writes nothing; the expiry sweep skips it; the newer proposal still publishes normally and the superseded row stays as the only decision.
- `apps/worker/test/pipeline-flow-api.test.ts` and `apps/web/test/pipeline-flow-model.test.ts`: the review node carries `supersede_24h`, the "digantikan" chip and the label "Digantikan versi baru" are distinct from "kedaluwarsa", and a snapshot without the key shows no chip.
