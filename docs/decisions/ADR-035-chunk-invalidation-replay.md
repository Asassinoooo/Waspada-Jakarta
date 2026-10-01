# ADR-035 — Invalidated chunk generations are not retry targets

- **Status:** Accepted design; correction planned
- **Date:** 1 October 2026
- **Owner:** Root planner
- **Task:** DATA-02-CHUNK-INVALIDATION-REPLAY-CORE
- **Requirements:** FR-03/05/13; NFR-01/05/07

## Evidence and decision

Root reproduced a stale retry in WSL/PGlite using the existing chunk test with one added old-set replay. After chunker-old was superseded by chunker-new, replaying the old set made its chunk active again and invalidated the new chunk. The extended test had four passes and one failure. This is a confirmed local defect, not a claim about hosted concurrency.

Treat persisted invalidated chunks as tombstones. An input that reuses an invalidated chunk ID, or a chunker version already invalidated for that exact dataset/revision, is rejected before any inserts or status changes. New IDs must not bypass a known invalidated generation. Existing active identical sets remain replay-compatible; a genuinely new chunker version can replace them through the existing atomic write/invalidation statement. Version labels are opaque: do not infer chronology from their spelling. Restoring an old generation is not an automatic retry action.

Require the revision to remain unreviewed or eligible in the write statement. Quarantined, superseded and retracted revisions cannot create or refresh active chunks. Preserve immutable source text, old chunk/run history and vector rows. Failed guards must leave the entire input set and every current/old status unchanged. Keep the existing repository input/result contracts and L1 grants; no schema, migration or provider change is required by this slice.

## Trade-offs and limits

Rejecting a stale generation makes an old job fail explicitly rather than silently undoing a later re-chunking operation. A planned restoration would need a separately reviewed design and a new generation. The existing revision-state read and statement guards narrow this local behavior; PGlite does not establish independent-session serialization or ordering for competing new generations. Do not claim that this correction solves hosted concurrency. L2 continues to recheck revision/chunk/run eligibility during retrieval.

## Verification

Add permanent regression tests under the L1 role for old-set replay, new-ID reuse of a tombstoned version, mixed stale/new inputs without partial writes, denied revision states, normal active replay, a new generation and retained vector/run history. Run the actual chunk/embedding/retrieval composition locally; source rights, model quality and hosted Neon remain unverified.
