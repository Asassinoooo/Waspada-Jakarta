# PUB-OUTBOX-DELIVERY-CORE handoff

## Branch and commits

- Branch: work/PUB-OUTBOX-DELIVERY-CORE
- Worktree: /mnt/d/Projects/RPL/.codex-build/worktrees/pub-outbox-delivery-core
- Assigned base: 33bafac0efafdea5860b5c4ce65fa86f130af1e2
- Implementation commit: 4eaaeefa62a8988c4769aa161d734c6833d2fa3b - feat(PUB-OUTBOX-DELIVERY-CORE): add durable publication outbox relay
- This handoff is committed separately as docs(PUB-OUTBOX-DELIVERY-CORE): record implementation handoff.

## Changed paths

- apps/db/migrations/027_publication_outbox_delivery.sql
- apps/db/src/publication-outbox-delivery.ts
- apps/db/test/migrations.test.ts
- apps/db/test/public-event-updates.test.ts
- apps/db/test/publication-outbox-delivery.test.ts
- apps/worker/package.json
- apps/worker/src/layers/l5-evaluation-monitoring/publication-outbox-delivery-telemetry.ts
- apps/worker/src/runtime/publication-outbox-delivery-runtime.ts
- apps/worker/test/publication-outbox-delivery-runtime.test.ts
- docs/assignments/PUB-OUTBOX-DELIVERY-CORE-HANDOFF.md

public-event-updates.test.ts has only the authorized fixture adjustment: migration 027 is left out of its initial partial migration set and included in the subsequent applied migration list.

## Behavior delivered

Migration 027 adds the NOLOGIN/NOINHERIT delivery capability and separate append-only attempt and result tables. It grants the delivery role only the required publication-outbox columns and ledger reads/inserts; it does not change existing publication_outbox grants, add role membership, or grant attempt/result mutation.

The database repository reserves one stable-ordered page of at most 20 notices in a short transaction and writes each result in its own short transaction. Advisory transaction locks serialize competing claims without changing the original outbox. A 60-second lease permits recovery after a worker stops. Reservation replay validates the same reservation key and time and returns only unresolved/latest attempts. Retries use deterministic exponential backoff from one second, capped at one hour. Any recorded delivered or permanent_failure is terminal across attempts, including late results; a late retryable failure cannot reopen a terminal notice.

The Worker runtime processes one page serially and calls the injected sink outside SQL transactions. The sink receives only {eventId, eventVersion, eventKind, occurredAt}; outbox_id is passed separately as the stable idempotency key. Sink calls have a finite default five-second timeout, bounded to at most 30 seconds. Uncertain calls are retryable, and durable-result failure can cause another call with the same key. This implements at-least-once transport; it makes no exactly-once network claim.

Layer 5 telemetry accepts only a fixed outcome, finite duration, and bounded counts. It excludes identifiers, payloads, content, claims, evidence, geometries, and raw errors; telemetry failure does not alter delivery state.

## Verification

All project verification was run in WSL Ubuntu-26.04 with Node v24.21.0 and npm 11.19.0. No dependencies were installed; the existing repository node_modules was temporarily symlinked into the worktree and removed before handoff.

- Focused PGlite outbox ledger test: 7/7 passed, including page cap/order, replay/conflict, expiry, retry boundaries, and both late-result terminal cases.
- Focused Worker runtime test: 6/6 passed, including same-key idempotency, uncertain sink recovery, timeout, closed telemetry, and telemetry/storage failure behavior.
- Adjusted public-event-updates.test.ts: 4/4 passed.
- npm run db:test: 32/32 DB test files passed.
- npm test: exited 0; Worker workspace 423/423 passed, DB workspace 32/32 files passed, and evaluation casebook 12/12 passed. The web workspace also completed without failures.
- npm run typecheck: exited 0 for web, Worker, DB, and evaluation TypeScript projects.
- npm run build: exited 0; Vite production build and Wrangler Worker dry-run build succeeded.
- git diff --check 33bafac0efafdea5860b5c4ce65fa86f130af1e2..HEAD: exited 0.

## Limitations and configuration impact

No scheduled handler, Cron, API route, public contract, external sink, provider, cloud resource, credential binding, or live trigger was added. A caller must explicitly supply exact datasetMode=live, relayEnabled=true, a valid deliveryWriterConnectionString, and an injected idempotent sink before the runtime can be created. The sink is responsible for durably deduplicating logical effects by outbox_id. The runtime otherwise stays dormant.

The migration creates a NOLOGIN role without granting it to a login principal, as required by the capability boundary. A production connection must therefore have an approved way to execute SET ROLE waspada_l4_publication_outbox_delivery; the assignment does not define or provision that principal binding. PGlite coverage uses an authorized test executor and a local fake sink, so hosted connection authorization and remote sink behavior remain unverified.

No further contract or schema decision was introduced. Root independently reviewed the capability grants and late-result terminal behavior, passed the focused tests plus full WSL workspace, typecheck, build and diff checks, and accepted the work on local `main`. The checked-in Worker still does not configure or invoke the runtime.
