# ADR-013 — Manual publication write transaction

- **Status:** Accepted for local implementation
- **Date:** 25 September 2026
- **Owners:** Root planner/reviewer

## Context

Layer 4 has a pure manual publication assessment and a separate safe public projection. The database schema stores publication decisions, immutable event/impact versions, claim evidence, and an audit trail, but no service commits them as one operation. A partial write or stale event version could otherwise leave an inconsistent published view. Retried moderator requests also need an idempotency boundary and a durable notification record.

## Decision

- Add a local L4 persistence service that accepts an explicitly approved, all-required-claims-reviewed command from a trusted application caller. The service does not authenticate the reviewer; an HTTP authorization boundary remains future MOD-01 work.
- Commit the publication decision, per-claim decisions and evidence links, immutable event and impact versions, their claim/evidence/origin/geometry relations, an audit record, a privacy-minimal outbox row, and an idempotency receipt in one database transaction.
- Check the expected current event version within the transaction. A new event has no current version; an update must be exactly the next version of the supplied base version. A stale or conflicting command writes nothing.
- Scope idempotency to the live dataset. Repeating a key with the same canonical request returns the original result; reusing it for a different request fails with a bounded conflict. Store a request fingerprint and result identities, not a copy of the request.
- Check the configured dataset namespace inside the transaction and permit writes only when it is `live`; the caller's dataset field alone is not sufficient.
- Keep the outbox append-only and limited to event identity, version, event kind, and occurrence time. Delivery, retry state and public payload rendering are later responsibilities.
- Restrict the writer to the existing Layer 4 publication role and narrow grants for any new tables. Persist only records that passed the explicit manual publication assessment. Automatic publication remains disabled.
- Test only in-memory synthetic/live-shaped records in local PGlite. Such fixtures are not actual live data, moderator authentication, source permission, or a publication-quality claim.

## Consequences

The local writer uses transaction-scoped advisory locks for idempotency, event and impact identities, and column-level reads on publication inputs. It can fail atomically and safely replay within the PGlite design. The shared L4 role still retains pre-existing source-policy, trace/audit and acquisition-queue privileges; a dedicated narrower runtime role and provider transaction adapter are required before route wiring. This work does not establish source rights, factual support, moderator identity, or hosted PostgreSQL/Neon concurrency behavior. Raw `record_json` remains internal and must pass through ADR-012's public projection before serialization.

## Affected requirements

FR-08/13; NFR-01/05/07.
