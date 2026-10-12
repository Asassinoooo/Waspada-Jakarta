# ADR-054 — Private model gateway for local AI testing

- **Status:** Local testing direction accepted from the user on 12 October 2026; provider compatibility/runtime implementation remain unverified
- **Owner:** Team 12
- **Scope:** Model routing and evaluation configuration; public/schema-2.0 contracts and publication authority unchanged

## Context

The user chooses Gemini Embedding 2 on Google AI Studio Free and a Chinese preview model curated weekly, both through their 9router over Tailscale. They report a minimum 128k context and unmetered access for the curated model, and project embedding limits of 100 RPM / 30,000 TPM / 1,000 RPD. These account/provider facts are supplied by the user; no signed-in dashboard or endpoint was inspected.

## Decision

- Use two model families for local integration tests: `gemini-embedding-2` at explicitly requested 768 dimensions/cosine, and the user-curated inference alias. Classification, extraction, grounded reasoning and planner profiles retain separate contracts/instructions/budgets even if sharing weights.
- Pin embedding model, dimension, prefix and index identity across query/chunk vectors. Its default 3,072 dimensions exceeds existing L1's 2,048 cap. Do not change the schema or switch embedding models through automatic fallback.
- Existing embedding requests are evidence-chunk-bound; arbitrary query text needs a separate typed private query-vector port. A fixed prefix must be versioned in a private embedding profile referenced by `vectorIndexVersion`, with compatible query/document formatting and source offsets/raw chunk hashes preserved. These are implementation gates, not existing fields.
- Resolve the underlying curated model/provider and capability metadata per run; record curation epoch and prompt versions. Hold an investigation's route stable. Weekly rotation requires fresh schema/Bahasa/grounding checks; unversioned aliases limit reproducibility. Context capacity does not increase the existing 12,000-token reported-usage validation or L3 budget.
- Current persisted proposal runs/planner metadata omit provider and curation epoch. Bind resolved identity/epoch/profile to trace/case/run IDs in a private evaluation/run manifest; do not imply those database/checkpoint fields already exist or alter the public/schema-2.0 contracts in this planning slice.
- Proposed embedding allocation is 80 RPM / 24,000 TPM / 800 RPD shared across indexing, queries, retries and other project traffic. It is a planning margin, not currently enforced configuration. Queue/defer on exhaustion with bounded retry; no paid fallback or billing upgrade.
- Current public upstream 9router code forwards Gemini dimensions but normalizes embedding usage to zero. Verify the installed version and actual vector/identity response; use conservative reservations where exact usage is unavailable, never treat fabricated zero as measured consumption.
- Embedding results currently carry no usage field. Separate trusted quota telemetry/reservations need a reviewed tokenizer/upper-bound policy; unknown chat usage consumes the L3 reservation or fails closed. Estimates must remain labelled estimates.
- Route local backend calls over an authenticated private tailnet. Keep credentials outside browser/Git. No Funnel, hosted Worker bridge, provider configuration or network change is authorized by this decision. Hosted connectivity needs separate design/verification.
- Disable gateway rewriting/compression for evidence-bearing calls, preserve contrary evidence/Unicode spans and account for hidden gateway retries. Models remain behind existing L2 contracts and L3 authority; L4 alone gates publication. L1 structured parsing/source budgets and L5 audit/privacy remain intact.
- Start with mocks and a separately bounded synthetic-only provider smoke once endpoint/credentials/aliases are configured. Real source transfer, factual-quality evaluation and publication remain under existing rights/review gates. Free-tier data handling must be considered before submitting real report excerpts.

## Consequences

The reported limits are sufficient in principle for a small local corpus. At 500 input tokens per single-input call, TPM caps the ceiling at 60 calls/minute; the proposed margin allows 48. A test day with 600 chunk calls plus 100 query calls uses 700 of the proposed 800-call budget, before other traffic/retries. This is a workload example, not a measured capacity guarantee.

No extra classifier, reranker or fine-tuning is needed to begin. Exact model quality, transport cancellation, quota semantics, usage metadata and version availability still need testing. The checked-in runtime remains provider-free and the moderator demo stays read-only.

The [model integration plan](../AI_MODEL_INTEGRATION_PLAN.md) details contracts and readiness; [REFERENCES.md](../../REFERENCES.md) retains dated official/source-code links. Earlier Cloudflare model candidates remain history and are superseded for local tests.
