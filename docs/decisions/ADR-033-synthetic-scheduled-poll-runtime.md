# ADR-033 — Opt-in synthetic scheduled-poll runtime

- **Status:** Accepted design; implementation assigned, hosted behavior unverified
- **Date:** 1 October 2026
- **Owner:** Root planner
- **Requirements:** FR-02/14; NFR-01/05/07/08
- **Task:** JOB-01-SYNTHETIC-SCHEDULE-RUNTIME-CORE

## Decision

Add a Worker `scheduled` entrypoint that can enqueue one bounded due-source batch through the accepted L1 scheduler. It performs no acquisition, queue claiming, model call, investigation, publication, or freshness transition. The existing queue remains authoritative for idempotency and source approval; scheduling only the current slot prevents a catch-up burst.

The runtime requires exact `DATASET_MODE=demo`, exact `SYNTHETIC_POLL_SCHEDULER_ENABLED=true`, and a valid connection string from a separate `L1_HYPERDRIVE` binding. It must never fall back to the public-reader `HYPERDRIVE` binding. Checked-in configuration stays disabled, with no binding, secret, Cron expression, or deployment change.

Validate the platform-supplied scheduled epoch before opening SQL. Use its UTC RFC3339 instant consistently for trace and scheduling. In one request-scoped SQL transaction, select the literal `waspada_l1_pipeline` role using `SET LOCAL ROLE`, verify the singleton database namespace is exactly `synthetic`, create a new synthetic trace, enqueue at most the existing 100-source bound, finish the trace with closed count-only metadata, and commit. Missing or mismatched namespace rolls back before creating a trace/job. No caller may supply a dataset, role, source approval, polling interval, or arbitrary metadata to this runtime.

Migration 021 grants L1 only `SELECT (dataset_kind)` on the existing namespace configuration table. It grants no namespace mutation, credential, role membership, publication authority, or new table. Future authorized provisioning must supply a login that can assume the L1 role; a binding alone does not establish access.

Failures roll back and surface a bounded redacted runtime error. Preserve no raw connection string, exception, source content, or identifiers in error/log messages. Successful trace metadata records the trigger kind and scheduler counts only. A repeated trigger may create another trace, but existing queue keys and active-job suppression prevent duplicate logical polling work.

## Validation and limits

Fake-client checks verify configuration and timestamp preflight, transaction ordering, rollback and safe errors. PGlite checks run the actual entry runtime, role selection, scheduler and queue against synthetic fixtures, including repeat invocation and no event/publication writes. These do not prove independent PostgreSQL concurrency, Cloudflare Cron execution, Hyperdrive role membership, Neon behavior, or hosted free-tier costs. The handler is compiled locally but no schedule is enabled. Synthetic intake processing remains a separately invoked L1 runner.
