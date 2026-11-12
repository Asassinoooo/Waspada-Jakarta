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
