# ADR-036 — Grounded draft proposal persistence

- **Status:** Accepted design; local implementation assigned, acceptance pending
- **Date:** 1 October 2026
- **Owner:** Root planner
- **Task:** L2-PROPOSAL-PERSIST-CORE
- **Requirements:** FR-05/06/08/14; NFR-01/05/07

## Context

Layer 2 persists a refs-only grounding context before direct reasoning. The reasoning adapter returns a typed assessment, while proposal tables are currently populated only by test setup. There is no typed writer for the canonical schema 2.0 EventProposal. A durable draft boundary is needed before a later reasoning-result bridge can feed Layer 4 without acquiring publication authority.

The draft schema permits `under_review` and 4,000-code-point claim text; the foundation's proposal table permits only public labels and 2,000 characters. This discrepancy concerns private drafts. Public claim constraints and the existing publication writer remain unchanged and fail closed for unsupported draft values.

## Decision

- Add one transaction-required create-or-verify repository for the closed canonical EventProposal, including empty-claim abstentions, uncertain/disputed assessments, original time precision, unresolved fields and canonical model-run metadata. Store no expanded reasoning context, provider response, prompt, source excerpt or private reasoning. The linked immutable grounding context retains its conflicts and gaps.
- Snapshot validated nested input before any await. Bound this local writer to 20 claims; 100 evidence references per claim across all three lists; 200 references across the proposal; 100 origin IDs per claim; 100 entries in each scope/qualifier/unresolved-field list; and 20 model runs. Text retains the canonical 4,000-code-point limit, strings 500, IDs 128. Model/prompt labels are capped at 200 code points and per-run input plus output tokens at 12,000. These are local execution budgets, not schema changes or model selection.
- Validate real calendar dates, RFC3339 offsets, interval ordering and exact/date/range/unknown shapes. Date precision never becomes midnight in the stored record. Date-times accept at most six fractional digits and normalized UTC years 1–9999, matching local PostgreSQL precision. Reject invalid scalar strings, NULs and non-finite/unsafe numbers before SQL; redact operational errors.
- Require the proposal's same-dataset trace/candidate to match its persisted grounding context. Resolve every support, contradiction, update and context reference by exact revision/hash/span/offset/relation through that context's normalized evidence links. Never substitute a similar span or omit contrary evidence. This resolves lineage only; current source eligibility, semantic support and publication permission remain Layer 4 checks.
- Require every declared origin to have a stored exact `origin_evidence` link to at least one support reference of that claim, and every support reference to have a link to at least one declared origin. Do not count contradiction/context origins as support or infer independence from IDs. Unknown/dependent origins remain valid draft provenance; Layer 4 owns corroboration decisions.
- For an existing-event target, require the exact event/base-version pair in the persisted context's candidate links. Null targets remain drafts. A non-null investigation ID must identify the same dataset/candidate and immutable request target pair. An initial context uses the request's original trace; a refreshed context uses a recorded checkpoint with the exact context/trace/candidate/target pair, which may have a different trace from the initial request. The proposal trace always matches its persisted context. This follows the existing L3 refresh ledger and does not consume budgets, require the latest checkpoint, change case state, decide sufficiency or close investigations.
- Write the proposal, normalized claims, evidence and origin links atomically. Serialize dataset/proposal identity; identical canonical JSON payload and complete matching normalized rows replay, while changed payload or missing/extra/mismatched stored links conflict without repair. Array order is part of the canonical payload. Equivalent timestamp spelling is a changed payload, not an automatic rewrite. A failed child insert rolls back the entire new draft.
- Migration 023 aligns only draft claim label/text constraints with the existing contract and adds a separate clamped NOLOGIN/NOINHERIT `waspada_l2_proposal_writer`. Grant exact column-level reads for lineage/replay and select/insert on proposal tables. No update/delete, sequence, role membership, report/context/origin/investigation writes, publication/audit/outbox writes or widened existing reader grants.

## Consequences and alternatives

Both future proposal paths can share a private, evidence-linked record before the existing Layer 4 gate. Saving `supported` or `under_review` establishes neither truth nor publication eligibility. Drafts with labels/text outside the current publication writer's narrower budget remain unpublishable through that writer; changing publication handling is separate work.

Persisting raw reasoning output would lose canonical identity and provenance requirements; granting the retrieval reader draft writes would blur the existing access boundary. Both are rejected. This task selects no model/provider, calls no model, adds no route/runtime trigger and enables no source or moderation mutation. Authored PGlite checks establish local storage/access behavior only; independent PostgreSQL concurrency, hosted Neon, semantic quality, data rights and authenticated moderation remain unverified.
