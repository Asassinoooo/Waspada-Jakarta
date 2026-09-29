# ADR-031 — One bounded L3 coordinator advance per invocation

- **Status:** Accepted for local implementation
- **Date:** 29 September 2026
- **Owner:** Root planner
- **Requirements:** FR-07; NFR-01/02/05/07
- **Related work:** ADR-014, ADR-017, ADR-027, ADR-029, ADR-030, AGENT-01

## Context

L2 now supplies a typed proposal for one action, while L3 has durable case budgets, single-call/single-action executors, duplicate-action fingerprints, and replay-safe grounding-progress snapshots. No coordinator composes those boundaries yet. Source rights, reviewed evaluation cases, production model configuration, hosted Neon behavior, and Cloudflare Workflow configuration remain gated, so this orchestration boundary must be testable locally without activating any of them.

## Decision

- A coordinator invocation performs one bounded advance only. It may open/replay an investigation from a persisted insufficient L2 context, authorize at most one L2 planning call, execute at most one registered action, and request at most one post-action L1/L2 refresh. It does not loop until a model or tool stops.
- The coordinator delegates all inference to the existing Layer 2 planner through the Layer 3 reasoning-step executor. It never grants capabilities from model output: the action menu is supplied by trusted composition, and the existing single-step executor revalidates registration, input, current checkpoint, duplicate fingerprint and ledger budget before a handler can run.
- The sufficient-context path bypasses investigation. When refreshed context becomes sufficient, L3 returns that persisted context to the caller for Layer 2 synthesis; it does not synthesize claims or publish.
- Every acquisition result goes through an injected L1/L2 refresh boundary before it can inform another proposal. The coordinator does not fetch, parse, clean, extract, embed, or persist source content. It records refreshed context progress with the case-pinned grounding fingerprint and advances only the existing internal checkpoint.
- A changed grounding digest with remaining gaps returns a resumable continuation result and latest checkpoint for a later invocation. Two consecutive unchanged refreshes, an exact repeated action, abstention, budget exhaustion, invalid/stale identity, unavailable or uncertain execution, or a material dispute returns a bounded review outcome. No automatic retry or hidden fan-out is allowed.
- L4 remains the only publication authority. The coordinator has no public route, source registration, provider credential, Workflow binding, or moderation mutation.

## Consequences

The coordinator can be verified as a deterministic state machine using injected synthetic ports and the existing PGlite ledger. Durable checkpoints and counters remain authoritative across invocations; there is no process-local loop state to reset. A future runtime may schedule each continuation, but this ADR does not select or configure that runtime. Tests prove local orchestration contracts only, not retrieval quality, source permission, hosted Neon transactions, provider quality, Cloudflare runtime behavior, or live safety.

## Alternatives considered

- **Run an unbounded in-process agent loop:** rejected because it weakens per-step restart, time and budget boundaries and can create hidden fan-out.
- **Let the planner select or invoke arbitrary tools:** rejected because proposals are untrusted data and cannot replace L3 registration, validation, reservation or reconciliation.
- **Perform source cleanup or context construction in L3:** rejected because preprocessing belongs to L1 and grounding/retrieval belongs to L2.
- **Let sufficient or model-confident output publish directly:** rejected because L4 publication policy remains independent and deterministic.

