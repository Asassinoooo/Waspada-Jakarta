# ADR-014 — Durable bounded investigation ledger

- **Status:** Accepted for local implementation
- **Date:** 25 September 2026
- **Owner:** Root planner
- **Requirements:** FR-07; NFR-02/05/07
- **Related work:** DATA-01, RAG-ACCESS-01, AGENT-01

## Context

Schema 2.0 defines `InvestigationRequest`, `InvestigationCheckpoint`, per-case hard limits, consumed counters, and preflight reservations. The database tables exist, but no typed Layer 3 repository persists or reconciles them. The current checkpoint foreign key also forces every checkpoint to retain the request's original context, which conflicts with the planned L2 refresh loop: resumed work must use newer grounding while preserving the same case and budget.

Aggregate reserved counters alone do not identify which external or model action is safe to retry after an uncertain acknowledgement or process restart. A case ledger needs an idempotent action reservation alongside its versioned checkpoint snapshots.

## Decision

- Keep the schema 2.0 `InvestigationRequest` and `InvestigationCheckpoint` shapes unchanged. The request retains the initial insufficient grounding context. Each checkpoint references the latest grounding context for the same dataset and candidate, so resumed work may use refreshed L2 evidence without changing the case identity, event target, policy version, limits, or prior usage.
- Add an internal action-reservation table keyed by a caller-supplied stable reservation ID. It stores only action kind/name, reserved and actual budget units, timestamps, and bounded outcome status; it never stores source text, prompts, model output, or raw exceptions. At most one reservation may be in flight per investigation.
- `investigation_requests` holds the mutable aggregate counters; each budget or case-state transition appends a complete checkpoint snapshot. Reservation, counter update, snapshot, and reconciliation are transactional. Checkpoint versions are append-only.
- Reserve the worst-case action budget before invoking a tool or reasoning adapter. Reconcile successful and failed invocations exactly once. An interrupted invocation consumes its reserved maximum and is recorded as timed out before it can be retried. An action cancelled before invocation may release its reservation without consuming an attempt.
- Enforce the existing hard caps (5 tool attempts, 4 reasoning turns, 60 active seconds, 12,000 model tokens) and narrower configured per-case limits. Retries and resumes never reset limits or counters.
- Create a case only from a persisted `GroundingContext` whose `sufficient` field is false. The sufficient-context path bypasses Layer 3. A checkpoint may advance its context only to a persisted context for the same dataset and candidate. Neither the ledger nor Layer 3 publishes events; proposals still pass the deterministic L4 gate.
- Use a dedicated `NOLOGIN` coordinator role with only required column privileges. This does not authorize or configure a hosted runtime connection.

## Consequences and limits

The persistence boundary is locally testable with synthetic PGlite records and a role-scoped test. It enables a later coordinator to make bounded, resumable decisions without inventing an in-memory budget or retry rule. PGlite tests do not prove cross-session locking or hosted Neon behavior. No model provider, source tool, live source, scheduler binding, moderator route, or publication authorization is included.

## Alternatives considered

- **Keep only aggregate counters:** rejected because an uncertain action acknowledgement cannot be distinguished from a new action, permitting accidental duplicate execution.
- **Change the schema 2.0 JSON contract:** rejected because refreshed context can be represented by the existing checkpoint `context_id`; only the database relationship needs to change.
- **Permit parallel actions per case:** rejected for the prototype because hidden fan-out complicates deterministic budget reservation and stop conditions.
- **Clear stale reservations on restart:** rejected because a crashed external action may already have run; consuming the reservation maximum is the fail-closed recovery behavior.

## Affected files and requirements

`apps/db/migrations`, the database repository, and synthetic PGlite tests; FR-07 and NFR-02/05/07.
