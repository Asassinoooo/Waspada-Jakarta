# ADR-002 — Durable acquisition queue and scheduler boundary

- **Status:** Accepted for local implementation
- **Date:** 24 September 2026
- **Owner:** Root planner
- **Requirements:** FR-02, FR-13; NFR-05
- **Related work:** DATA-01, JOB-01, ING-01/02, LIFE-01, AGENT-01

## Context

Scheduled triggers can be late or repeated, and workers can stop after claiming work. A timer or Workflow execution therefore cannot be the sole record of what work is due, whether it completed, or how many attempts it consumed. At the same time, L1 source acquisition and preprocessing must remain separate from the bounded L3 investigation coordinator. Source health is operational state and must not change an incident's lifecycle or imply that no incident exists.

## Decision

Persist queue state in PostgreSQL. Cron or a local timer will only request due work; later Cloudflare Workflows may execute a bounded job by ID. The database row remains authoritative for identity, idempotency, attempts, lease state, retry time and outcome. The local JOB-01 slice will implement database-backed queue primitives and typed scheduler triggers, not Cloudflare Cron/Workflow bindings or a live connector.

Every enqueue carries a dataset-scoped idempotency key. Scheduled source polls are accepted only for an active, approved source with automatic acquisition enabled and an explicitly configured interval; this ADR does not approve or select a polling cadence. Moderator-submitted acquisitions use the same durable queue and downstream L1 pipeline, but the enqueue caller must already have passed MOD-01 authorization. The queue itself is not an authorization boundary.

Workers claim one job atomically with a finite lease and an unpredictable lease token. Renew, complete and fail operations require the current token, so an expired worker cannot acknowledge work after another worker reclaims it. Each claim consumes one bounded attempt. Retryable failures use capped exponential backoff; permanent failures and exhausted attempts move to a terminal review/dead-letter state. Expired leases are recovered durably. Error details stored in the queue are bounded and redacted; source text, credentials and raw exceptions do not belong in operational metadata.

Source health is updated independently from event state. A successful poll records check/success timestamps and healthy status; a retryable failure marks the connector degraded; a terminal or unavailable result may mark it unavailable while preserving its last success. A missing poll or source outage never resolves an event or implies an all-clear.

## Consequences and boundaries

- JOB-01 will add the queue migration and tested repository primitives using synthetic rows and the local PGlite harness.
- `source_registry.polling_interval_seconds` is configuration only. The unvalidated intervals in the project plan are not defaults or service commitments.
- Ingestion connectors, report preprocessing, public APIs, model calls, L3 investigation work, live-source permissions, moderator authentication, Cloudflare schedules, Neon integration and deployment remain separate tasks or authorization gates.
- Backoff and attempts are locally testable. Cloudflare Workflow replay, Neon locking/extension behavior, provider quotas and hosted latency remain unverified until an authorized provider test.

## Alternatives considered

- **Cron/Workflow as sole queue:** rejected because duplicate triggers, retries and restarts need a durable shared idempotency and attempt ledger.
- **In-memory queue:** rejected because process restarts lose queued/leased work and do not meet FR-02/NFR-05.
- **Agent-owned queue:** rejected because source scheduling and L1 ingestion are not L3 reasoning; the coordinator must not own the data platform.
