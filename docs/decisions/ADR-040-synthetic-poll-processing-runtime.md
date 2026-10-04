# ADR-040 — Separate synthetic source-poll processing runtime

- **Status:** Accepted for local, synthetic-only implementation
- **Date:** 4 October 2026
- **Owner:** Root planner
- **Requirements:** FR-02/03/13; NFR-01/02/05/07
- **Task:** `JOB-01-SYNTHETIC-POLL-WORKER-RUNTIME-CORE`

## Context

The L1 source-poll path already has a bounded due-source scheduler, a synthetic-only queue claim, an injected fixture processor, and a PGlite schedule-to-persistence test. The Worker scheduled entrypoint currently enqueues jobs but does not compose the processor. The accepted enqueue design in [ADR-033](ADR-033-synthetic-scheduled-poll-runtime.md) must stay limited to enqueueing.

The processor requires both an authored, already-buffered source-ID fixture catalog and the fixed L2 extraction capability. No real provider or API key is selected, so the current Worker must not claim jobs by fabricating successful extraction output.

## Decision

Add a separate, bounded L1 synthetic poll processing runtime and trigger. The Worker scheduled entrypoint may call the enqueue trigger and then the processor trigger sequentially, while each retains its own configuration and runtime boundary. This does not add a Cloudflare Cron schedule, queue resource, external source fetch, or durable Workflow.

The processor may be created only when all of the following hold:

- `DATASET_MODE` is exactly `demo`;
- `SYNTHETIC_POLL_PROCESSOR_ENABLED` is exactly `true`;
- `L1_HYPERDRIVE` contains a valid dedicated L1 connection string;
- the caller supplies an exact-source-ID synthetic fixture catalog and an L2 extraction adapter.

Missing configuration or either injected processing dependency returns before opening SQL or claiming a job. Never fall back to the public-reader `HYPERDRIVE` binding. The checked-in Worker does not compose a model provider or fixture catalog, so the processing path stays inactive even if the environment flag is mistakenly set.

An active invocation uses the existing `runSyntheticSourcePollJob` and processes at most one due job using the platform-supplied scheduled time. It sets the existing L1 role on one request-scoped PostgreSQL client and always resets it before client closure. It must not hold a transaction open across L2 extraction; existing repository transactions, queue leases, idempotency, and retry behavior remain authoritative. Use only the fixture catalog already in memory; do not fetch URLs, read runtime fixture files, or add a source connector.

Tests may inject a deterministic L2 adapter double and authored synthetic fixtures to prove the real queue/persistence composition. These tests prove local mechanics only; they are not model-quality or live-source validation. The injected real provider and approved source/data rights remain future gates.

## Consequences

The enqueue scheduler remains separately testable and does not claim or process jobs. A future authorized model/provider composition can supply the adapter without moving ingestion or cleaning into Layer 3. Without that adapter and catalog, the processor cannot consume work. No schema, migration, role grant, public API/DTO, package dependency, secret, external binding, provider configuration, or deployment state is changed.

## Validation

Use Worker fakes for gates, time validation, role/client lifecycle, one-job execution, bounded failures, and adapter/catalog absence. Use PGlite under the existing L1 role for the accepted queue-to-report/evidence/extraction/chunk/geometry flow, acknowledgement ordering, idempotent replay, and absence of Event/publication writes. Hosted Neon concurrency, Cloudflare scheduling, real-provider behavior, and live source access remain outside this decision.
