# ADR-041 — Bounded idempotent delivery for publication outbox notices

- **Status:** Accepted for local implementation; no external sink selected or configured
- **Date:** 4 October 2026
- **Owner:** Root planner
- **Requirements:** FR-08/13; NFR-01/02/04/05/07
- **Related work:** ADR-013, PUB-WRITE-CORE, JOB-01, OBS-01

## Context

The accepted Layer 4 publication transaction writes one minimal, immutable `publication_outbox` row atomically with each published event version. The application does not yet have a delivery worker or a selected downstream service. Leaving only a write-side outbox cannot exercise retry, replay, or the external-effect boundary locally. Conversely, choosing a provider or changing cloud resources is not needed to implement a durable relay.

## Decision

1. Preserve `publication_outbox` as append-only. Add separate append-only delivery-attempt and attempt-result records; delivery never updates/deletes an outbox row or changes the published event.
2. Deliver only a closed notice for `event_version_published`: event ID, event version, event kind, and original occurrence time. Pass the stable `outbox_id` separately as the idempotency key. Do not deliver the publication trace ID, dataset internals, source/report text, claims, evidence, geometries, payload JSON, credentials, or arbitrary errors.
3. Define an injected `PublicationNoticeSink` boundary. Delivery is at-least-once: leases can expire and a process can crash after the external effect but before recording success. The sink must durably deduplicate repeated calls by the same `outbox_id`; do not claim exactly-once network delivery. A local fake sink verifies one logical effect across replays. No concrete external sink is selected or configured.
4. Reserve attempts in a short database transaction, then call the sink outside any database transaction with a finite timeout. Record only a closed terminal outcome and bounded retry classification in a second transaction. A successful delivery is terminal. Retryable failures use deterministic exponential backoff capped at one hour; permanent failures become terminal and require a later explicit operator/redrive design. Expired leases can be retried with the same idempotency key.
5. Bound one pass to at most 20 notices in stable order. Do not loop, fan out, or perform implicit retries inside a pass. An invocation receives one explicit evaluation time; it cannot choose a dataset or publication payload.
6. Use a separate `NOLOGIN`/`NOINHERIT` Layer 4 capability for delivery reads and append-only attempt/result inserts. It cannot write publication/outbox rows, event versions, claims, evidence, moderation state, or source data. Do not provision role membership or credentials.
7. Record Layer 5 operational telemetry only as a fixed outcome, finite duration, and bounded attempt counts. Telemetry is best effort and cannot change delivery results. Never log notice IDs, sink responses, source content, URLs, connection details, or exception text.
8. This task does not add a Cron expression, scheduled Worker trigger, API route, public contract, cache invalidation policy, notification UI, or real sink. Publication notices are not source-retraction or freshness-transition notices; LIFE-01 source-revision invalidation remains separate.

## Consequences

Local PGlite and Worker tests can verify reservation, leases, backoff, append-only history, role boundaries, retry after crashes, and idempotent sink behavior without provider credentials. Hosted PostgreSQL concurrency and real sink idempotency remain unverified. A later integration must select a destination, provision its credentials, verify its deduplication guarantee, and add the appropriate trigger only after a bounded deployment task is authorized.

## Rejected alternatives

- Mutate delivery columns on `publication_outbox`: this breaks its append-only publication record and conflates the business event with transport state.
- Hold a database transaction open while calling an external sink: it increases lock duration and cannot make the external effect atomic with PostgreSQL.
- Claim exactly-once delivery: the database and remote sink do not share a transaction; stable idempotency keys provide retry-safe logical effects only when the sink honors them.
- Pick a specific notification/cache/cloud product now: no downstream product requirement or external authorization is available.
