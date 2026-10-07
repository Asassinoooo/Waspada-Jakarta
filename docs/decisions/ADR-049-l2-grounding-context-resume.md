# ADR-049 — Rehydrate refs-only grounding contexts on resume

- **Status:** Accepted
- **Date:** 7 October 2026
- **Owner:** Root planner
- **Affected scope:** L2 grounding and restart, L3 Workflow payload boundary, ADR-015/044

## Context

Layer 2 persists schema 2.0 `GroundingContextRecord` as a refs-only snapshot. It preserves the dataset/context/candidate identity, exact evidence revision/hash/span/relation tuples, revision states, candidate event versions, prior-decision IDs, retrieval/index versions, and the original sufficiency result. It intentionally omits report excerpts and source/provenance metadata. `L2-CONTEXT-READ-CORE` validates that record and its normalized links, but a restarted Workflow cannot pass the stored record directly to a reasoning model.

The resume path must reconstruct model input inside L2, using only the exact evidence selected before interruption. Broad hybrid search could select different evidence or omit a pinned reference due to ranking and bounds. A source may also have been explicitly superseded, retracted, or withdrawn since the context was saved.

## Decision

1. A resume caller supplies only `(dataset_kind, context_id)` to Layer 2. L2 performs the exact context read, then resolves no more than the eight exact evidence identities in the validated record. L3/Workflow state and event payloads remain identifier-only; they never carry excerpts, URLs, source content, or model-ready context.
2. For each saved natural identity, the L2 evidence reader must find exactly one current same-dataset reference linked to the saved candidate and matching report revision, permitted-text hash, span, offset unit, and relation. Missing, duplicate, malformed, cross-dataset, cross-candidate, or unexpected references stop rehydration with a stable content-free error. No broad search or replacement selection occurs during resume.
3. Current report revision status must equal the status pinned in the saved `revision_states`. The current source registry must still be `active` and `approved`; a source paused, retired, pending, suspended, or revoked since context creation requires fresh L2 retrieval/review before reasoning resumes. Source health alone is not a validity decision for already stored evidence and does not block resume.
4. L2 reloads the current source ID, source publication/observation/retrieval timestamps, and origin lineage/dependencies for each exact reference. It then reads each exact span through the existing source-revision invalidation gate. Any `superseded`, `retracted`, or `withdrawn` assertion blocks the span under ADR-044. The request is returned only after every pinned reference passes and the closed schema 2.0 model contract validates.
5. The resulting excerpt-bearing `ReasoningRequest` exists only in memory within L2 and is not written back into the context table or Workflow state. Candidate events, prior decisions, missing fields, conflicts, retrieval/index versions, and original sufficiency are copied from the validated record; resumption does not reclassify evidence or reassess sufficiency.
6. All reads use existing `waspada_l2_grounding_reader` column grants. Do not add a migration, role membership, broader grant, public/API field, prompt schema field, runtime, source/provider, model call, or deployment setting as part of this capability.

## Consequences

An unchanged, still-eligible context can be reconstructed deterministically from its saved evidence identities. Changed or invalid evidence never silently falls back to newly ranked results; it requires fresh L2 retrieval or an explicit review path. A source-health outage does not erase already stored evidence. The persisted schema and public API remain unchanged.

The local implementation is verified with synthetic PGlite fixtures and injected readers only. It does not prove hosted Neon isolation/concurrency, configure Cloudflare Workflows, or establish that a resumed model call is operationally enabled.

## Rejected alternatives

- Persist excerpts or source metadata in Workflow state: duplicates private source content and can outlive current evidence/source status.
- Repeat broad hybrid retrieval on resume: can change the evidence set and silently replace the context the investigation already evaluated.
- Let L3 read evidence content: crosses the L2 grounding boundary and expands access without need.
- Continue after a missing, duplicate, changed, or invalidated reference: breaks the pinned-context identity or source-invalidation guarantee.
