# ADR-047: Resumable source-revision freshness runs

- **Status:** Accepted — planner decision, 5 October 2026
- **Decision owners:** Waspada Jakarta planning/review lead
- **Related:** ADR-038, ADR-039, ADR-043, ADR-045, ADR-046; `LIFE-01-SOURCE-REVISION-FRESHNESS-TRANSITION-CORE`

## Context

The source-revision freshness coordinator processes one bounded keyset page of at most 100 candidates. The candidate reader continues to return explicit invalidating observations after their target has become `needs_update`, so a scheduled caller that restarts every slot with a null cursor can revisit the same first page indefinitely. Reprocessing is safe, but it does not guarantee progress through later candidates.

## Decision

Persist one private live cursor checkpoint for the source-revision freshness scan. Null means a new sweep. After a complete page, store its exact continuation cursor; after a complete terminal page, reset to null. A failed read, write, or stale conflict leaves the checkpoint unchanged.

Give each stable scheduled-slot run an immutable input-cursor snapshot on its first begin. Retrying that same run uses its original page even if a prior attempt advanced the global checkpoint. Checkpoint advancement is compare-and-set: it succeeds when the stored cursor matches the run's input, replays when the requested output cursor is already stored, and conflicts when another run advanced to different progress.

Store run lifecycle through fixed-purpose database functions that create/finalize the existing live trace record with a fixed trigger name and count-only summary. Store the private input cursor separately from trace metadata. Only the existing L4 freshness-writer role may execute the functions; application roles receive no direct table access. The functions validate a closed cursor shape containing only observation and exact event/impact identity. They persist no report or claim text.

The later scheduled runtime remains a separate, disabled-by-default slice. This decision does not configure a Cron trigger, database binding, source acquisition, hosted membership, or deployment.

## Consequences

- Each future scheduled invocation remains bounded to one candidate page while successive slots can finish a full keyset sweep.
- Replays, interrupted runs, and overlapping slots cannot move the checkpoint backwards or skip a failed page.
- A newly inserted candidate that sorts before the current cursor may wait until the next sweep begins; every completed sweep resets to null so it remains discoverable.
- The cursor is private operational metadata and includes source-observation identity. It must not appear in public DTOs, telemetry, logs, or error text.
- Existing freshness-due trace functions are not reused because their trigger identity and fixed count summary describe due evaluation, not source-revision transitions.

## Validation required

Use authored PGlite fixtures to verify the run/cursor state machine, strict capability grants, cursor privacy, exact replay, stale compare-and-set conflicts, and migration ordering. No hosted or live-source test is authorized.
