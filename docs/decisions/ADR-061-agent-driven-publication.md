# ADR-061 — Agent-driven publication with a deterministic discrepancy gate

- **Status:** Accepted on 11 November 2026 under MERGE-REVIEW-01. Amends the Software Development Plan rule that only human-reviewed versions are published. Keeps [ADR-052](ADR-052-moderator-selected-public-evidence-labels.md) (only a moderator may choose `independent_corroboration`) and [ADR-060](ADR-060-password-accounts.md) unchanged.
- **Date:** 2026-11-11
- **Owner:** Team 12
- **Scope:** The live intelligence pipeline (`apps/intelligence`), the Worker's internal proposal route, the L4 gate and writer, the moderation publish and reject routes, the public `#jelajah` read, the local live server startup, and the moderator and public web views. Source rights, lifecycle and freshness rules are unchanged.

## Context

The owner decided on 11 November 2026 that the app is agent-driven. The AI merges articles about one physical incident into one event, and each claim is attributed to its outlet. Events without a discrepancy publish without waiting for a moderator. Events with an AI-identified discrepancy wait for a moderator. Before this change, the live path had these problems:

- Multi-source merges set `is_corroborated` and an invented `source_count`, and mapped the label to `independent_corroboration`.
- The public `#jelajah` page read the moderation queue, filtered it by keywords, and claimed verification. The public projection named a fabricated source ("Laporan Terverifikasi", `waspada.jakarta.go.id`).
- The moderator publish path ran for `action: "reject"`, so rejection published.
- The local live server republished every multi-source proposal on startup, and an unused script wrote `independent_corroboration` as `system-corroborator`.
- The public list in live mode fell back to synthetic fixtures when no event was published.

## Decision

1. **Merging stays with the AI.** The correlation agent merges a report into an existing incident when it judges the report to be the same event. Each claim keeps its publisher (`source_id`, `outlet`) and its article URL (`source_url`). The label is `attributed_report`, or `issuer_notice` for BMKG and `crowdsourced_observation` for PetaBencana. The AI never writes `independent_corroboration`, and only a moderator may choose it.
2. **Discrepancy from the same call.** The correlation output schema gains `has_discrepancy` (boolean) and `discrepancy_summary` (Bahasa Indonesia, required when the flag is true). A flagged discrepancy must be explained. A skipped correlation (no candidate at or above the similarity threshold) is deterministic and sets `has_discrepancy: false`.
3. **`source_count` is distinct publishers.** A publisher is the registry source, or the outlet name when there is no registry source. A single proposal never invents a count. Syndicated copies with the same headline inside 48 hours are dropped by the Stage A title dedupe before any model call. The public page reads "dilaporkan oleh N media".
4. **Chain head.** A merge extends the latest proposal for the incident that is neither rejected nor unresolved. Each merge is built from the previous head, so the head holds every accepted claim. Ordering by `source_count` is not used, because distinct publishers can tie and an older tie would drop claims.
5. **Discrepancies are sticky.** A merged version keeps `has_discrepancy` true once any member carries a discrepancy, until a moderator decides.
6. **Automatic publication gate.** `assessAutoPublication` in `publication-policy.ts` publishes only when every check passes. Any missing or unknown value fails closed:
   - `has_discrepancy` is exactly `false`, and no discrepancy is listed;
   - the correlation is `primary_initial` or `corroborating`, not `unresolved`;
   - every claim is supported, quoted, and labelled `attributed_report`, `issuer_notice` or `crowdsourced_observation`;
   - every claim has an `https` source link and a source whose current registry permission grants public display;
   - the schema is valid, with a registry-style official category, a title and a proposal time;
   - a location and an event time (not `unknown` precision) come from the source.
7. **One writer for both actors.** `decideProposal` in `proposal-publication.ts` is the only path that writes a publication decision. The agent (`agent:auto-publisher`) and moderators both call it. Each publish writes, in one transaction, a `publication_decisions` row, an `event_versions` row, and its `event_claims`. The public read model is updated after the commit. The audit row records the actor, the publication mode, and the gate reasons.
8. **Moderator publication uses the same writer with a lighter gate.** A moderator has reviewed the proposal, so the discrepancy status does not block it. Schema, claim links and source rights still apply to every claim source, and no moderator approval overrides missing rights.
9. **Rejection never publishes.** `reject` records a `publication_decisions` row with `disposition: "reject"` and no event. Rejected proposals leave the queue and cannot become chain heads. Any other action is refused with 400.
10. **Conflicting new versions wait.** A new proposal for a published event is a new version. If it carries a discrepancy, or any gate check fails, it waits in the queue. The previous version stays public until a moderator or the gate publishes a newer one.
11. **Unresolved reports stay on their own.** A report the correlator marks unresolved is not chained into the event, and it never auto-publishes. Its claim stays only in its own proposal, as before.
12. **Public read.** `#jelajah` reads only `/api/v1/events`, which returns published versions. The live list never falls back to demo fixtures. An event's public id is its incident id, so a new version replaces the old version in place. `EventDetail` gains an additive `publication` object (`mode`, `source_count`). Each claim lists only its own source, and no fabricated source or date is shown. The map draws no severity-based radius.
13. **Startup.** The local live server no longer publishes multi-source proposals. It restores only versions that have a `publish` decision, in decision order. `tools/consolidate-live-incidents.ts` is deleted.
14. **No migration.** Decisions use the existing `publication_decisions.record_json` and the existing `event_versions` and `event_claims` tables. Migration 047 is not needed.

## Trade-offs and gates

- **The L2 policy is not applied to agent proposals.** `assessPublicationPolicy` and `manual-publication-service.ts` need a grounding context, a reasoning result, retrieval results and evidence freshness state. The agent pipeline produces none of them, and inventing that state would break the "never claim proof" rule. The agent gate therefore uses the deterministic data checks above. A later ADR must decide whether the L2 contract should be adapted to the agent pipeline. This is the largest deviation from the earlier plan.
- **Source rights decide most automatic publication.** A claim publishes automatically only if its registry source grants public display. [SOURCE_CLEARANCE_PLAN.md](../SOURCE_CLEARANCE_PLAN.md) records BMKG and ANTARA as needing permission, and the other live outlets are not covered. Until permissions are recorded, most agent proposals will wait for a moderator. That is the fail-closed outcome, not a bug.
- **BMKG events wait.** The BMKG earthquake text has no event time, so the time check queues it.
- **The notification is a single attempt.** The job runner calls the internal route once, with a 3 second timeout. If the call fails, the proposal stays in the moderator queue. No sweep retries it yet. This is safe, but it means automatic publication can lag.
- **Moderators cannot yet choose `independent_corroboration`.** The moderation API accepts only `attributed_report` and `crowdsourced_observation`. The option is removed from the web view and is never pre-selected.
- **`discrepancy_summary` cites report revision ids, not claim ids.** Claim ids are assigned after correlation, so the summary cannot name them. The moderator view shows the conflicting claims side by side with their own ids.
- **Concurrency.** The duplicate-decision check is not locked. Two concurrent requests for the same proposal can both pass it. That is acceptable for the single-operator local live mode, but hosted use needs an advisory lock, as the proposal writer already uses for proposal ids.
- **Hosted deployment and Neon are not verified.** The Cloudflare Worker composition and Neon grants for the new writes are a hosted gate.

## Verification boundary

MERGE-REVIEW-01 is covered by these tests, which use mocks and PGlite and make no network or model calls:

- `apps/intelligence/test/merge-review.test.ts`: no-discrepancy merge (publisher-attributed claims, gate passes), discrepancy merge (flagged, gate queues), claims kept when publisher counts tie, unresolved report not chained, rejected head skipped, no `independent_corroboration` written.
- `apps/intelligence/test/workflow.test.ts`: corroboration test updated to the new claim contract.
- `apps/worker/test/merge-review-gate.test.ts`: the pure gate and the moderation reject rule.
- `apps/worker/test/merge-review-publication.test.ts`: the decision writer against the proposal and audit tables: agent auto-publish with the `agent:auto-publisher` actor, a discrepancy queued, a conflicting version queued while the old version stays public, reject, moderator publish, rights denial.
- `apps/web/test/public-published-feed.test.tsx`: `#jelajah` renders only published events, each claim links to its own source, and no moderation endpoint is called.
- Updated: `apps/worker/test/service-auth-routes.test.ts` (the internal route answers 503 without a database), `apps/web/test/moderator-review.test.tsx` (no pre-selected corroboration, discrepancy-first detail, no radius).

Not verified: a bounded `npm run serve:live` session with real feeds and model calls, and any hosted deployment.

## Amendment (2026-11-11): local live mode

MERGE-REVIEW-01B. Most live outlets have no recorded public-display permission, so nearly every agent proposal would wait for a moderator in the local live prototype. The owner accepted a narrow relaxation for local live mode only.

- **Flag.** `AUTO_PUBLISH_SOURCE_PERMISSION` takes `required` or `local_relaxed`. It is parsed by `parseAutoPublishSourcePermission` in `publication-policy.ts`. Unset or any other value means `required`, so the check fails closed.
- **What `local_relaxed` waives.** Only the public-display permission check (`source_rights_missing`) in `evaluateAutoPublication`, for claims that would otherwise fail it. Every other automatic check still applies: no discrepancy, a `primary_initial` or `corroborating` correlation, supported and quoted claims, allowed labels, an `https` source link on every claim, a valid schema, and a location and an event time from the source.
- **Where it is set.** Only `tools/serve-live-pipeline.ts` sets `local_relaxed`, in the `WorkerEnvironment` it passes to the Worker's `fetch`. That server binds to `127.0.0.1` and logs one startup line when the relaxation is active. `wrangler.toml`, `.dev.vars.example` (the default is documented as a comment only), and the hosted environment never set it. **Hosted or public deployments must keep `required`.** Any change to that rule needs a new ADR.
- **Moderators are unchanged.** The moderator publish path uses `assessProposalSourceGate`, which has no waiver. Moderator approval still never overrides missing rights.
- **Audit.** A waiver is recorded only when the check actually failed and was skipped. The publication decision's `record_json.waivers` then holds `source_permission_waived_local`. The public `EventDetail.publication` gains the same additive `waivers` array, so a published event shows that its permission was waived. Startup restore keeps the label. A version published with every source already permitted has no waiver field.
- **Scope of the waiver.** A claim with no registry `source_id`, but with an outlet and link, is covered by the same waiver because it fails the same `source_rights_missing` check. Its source link is still required.
- **Verification.** `apps/worker/test/merge-review-gate.test.ts` covers the parser, the default, the waiver, and that discrepancy and missing-link checks still queue. `apps/worker/test/merge-review-publication.test.ts` covers unset and garbage values queuing, `local_relaxed` publishing with the waiver on the decision and the event, and moderator publish staying denied. Both use mocks or PGlite and make no network or model calls.
