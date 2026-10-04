# PUB-OUTBOX-DELIVERY-CORE — bounded publication notice relay

- **Status:** Accepted on local `main`; root review and required checks passed
- **Parent:** PUB-01; contributes to LIFE-01 outbox/replay infrastructure
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch:** `work/PUB-OUTBOX-DELIVERY-CORE`
- **Worktree:** `.codex-build/worktrees/pub-outbox-delivery-core`
- **Base:** `33bafac0efafdea5860b5c4ce65fa86f130af1e2`
- **Implementation commit:** `4eaaeefa62a8988c4769aa161d734c6833d2fa3b` (`feat(PUB-OUTBOX-DELIVERY-CORE): add durable publication outbox relay`)
- **Handoff commit:** `d9ffb452402c198d74023539fcf91abf380380c9` (`docs(PUB-OUTBOX-DELIVERY-CORE): record implementation handoff`)
- **Requirements:** FR-08/13; NFR-01/02/04/05/07
- **Dependencies:** `PUB-WRITE-CORE`, `DB-POSTGRES-TRANSACTIONAL-SQL-EXECUTOR-CORE`, `OBS-01-API-TELEMETRY-CORE`, ADR-013/041.
- **Contract baseline:** Existing immutable publication outbox in migration 005; no public API/DTO/OpenAPI or domain contract changes.

## Objective

Implement a bounded relay for existing `event_version_published` rows using an injected idempotent sink. Persist reservations and results in a separate append-only ledger. Exercise the complete delivery/retry path with PGlite and a local fake sink. No provider, destination, runtime trigger, or live data is enabled.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`, `ARCHITECTURE.md`, and `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/decisions/ADR-013-publication-write-transaction.md` and `docs/decisions/ADR-041-publication-outbox-delivery.md`
- `docs/assignments/PUB-WRITE-CORE.md` and its handoff
- `docs/assignments/DB-POSTGRES-TRANSACTIONAL-SQL-EXECUTOR-CORE.md`
- `apps/db/migrations/005_publication_write_receipts_outbox.sql`, `apps/db/migrations/017_moderator_publication_writer_role.sql`, and `apps/db/migrations/026_freshness_due_run_traces.sql`
- Existing DB migration, publication-writer, telemetry and Worker runtime tests

## Required behavior

1. Add an additive migration for a dedicated `NOLOGIN`/`NOINHERIT` delivery capability and append-only attempt/result records. Grant only the exact outbox/ledger reads and attempt/result inserts. Do not grant `UPDATE` or `DELETE`, role membership, direct event/publication writes, or broad source/content reads.
2. Add a typed database relay repository. For an explicit validated time, claim no more than 20 ready notices in stable order. Use short transactions for reservation and result writes; never hold a transaction while calling the sink. A live outbox row can have at most one unexpired pending lease. An expired lease is recoverable, and attempts remain append-only.
3. Deliver a closed `PublicationNotice` for `event_version_published`, with `outbox_id` as the separate idempotency key. Do not forward `trace_id` or any data beyond event ID, version, kind and original `occurred_at`. The sink is injected and must deduplicate repeated idempotency keys.
4. Model only the ADR-041 outcomes: `delivered`, `retryable_failure`, or `permanent_failure`. Store fixed classifications, timestamps and retry eligibility only; never persist exception messages, remote bodies, URLs, credentials, raw payloads or content. Retryable outcomes use deterministic exponential backoff capped at one hour. Permanent failures are terminal; no redrive endpoint is included.
5. Bound the sink call with a finite timeout. A thrown/uncertain call is recorded as retryable, then a later attempt reuses the exact same idempotency key. If success cannot be recorded after the sink returns, a replay may call the sink again, but the fake sink must show only one logical side effect.
6. Process one page only, serially, with no in-process loop beyond that page. Stop safely on repository/persistence failure; do not acknowledge delivery before a successful sink response and durable result record. Failed items must not silently disappear.
7. Add closed, privacy-safe Layer 5 telemetry for each active pass: outcome, finite duration and bounded counts only. Telemetry failure cannot alter the pass result. Gated or absent dependencies must return before database access and emit no event.
8. Do not wire a Cron, scheduled handler, database binding, cloud resource, external sink, public route, API/schema, source connector, publication writer, or moderator mutation. Do not claim hosted Neon behavior or exactly-once network delivery.

## Allowed paths

- `apps/db/migrations/027_publication_outbox_delivery.sql`
- New relay module under `apps/db/src/` and its focused test under `apps/db/test/`
- `apps/db/test/migrations.test.ts` for migration inventory/order assertions only
- `apps/db/test/public-event-updates.test.ts` only to exclude migration 027 from its partial precondition set and include it in the later applied set
- New Worker relay runtime/telemetry modules under `apps/worker/src/`
- Focused Worker and PGlite tests under `apps/worker/test/` or `apps/db/test/`
- `apps/worker/package.json` only to register focused tests
- This assignment's `-HANDOFF.md`

Root owns ADRs, architecture, backlog, SDP, checkpoint, delivery log and scope changes. Ask root before changing any other path, SQL contract, or capability boundary. Preserve all in-progress user decisions about freshness and source retractions; this slice delivers publication-version notices only.

The assigned branch is integrated on local `main`. Root independently reviewed the migration, capability grants, retry/late-result behavior and runtime gates; accepted test and configuration evidence is recorded in the [handoff](PUB-OUTBOX-DELIVERY-CORE-HANDOFF.md) and [delivery log](../DELIVERY_LOG.md). A production connection still needs an approved `SET ROLE waspada_l4_publication_outbox_delivery` path, and no sink or runtime trigger is configured.

## Acceptance and verification

- PGlite proves real publication outbox rows can be reserved and delivered under the new capability role; outbox rows, attempt rows and result rows reject mutation/deletion, and unrelated publication/source reads/writes are denied.
- Tests cover stable ordering and the 20-item cap, no claim for delivered/permanent/current-lease/not-yet-due rows, reservation replay/conflict, lease expiry, retry backoff boundaries, exact notice allowlist, stable idempotency key, sink success, retryable/permanent failures, and failure between sink success and persisted result.
- A local idempotent fake sink proves one logical effect despite repeated calls. No test result may be presented as real remote sink behavior.
- Tests prove telemetry excludes IDs/content/remote errors and sink/telemetry failures do not corrupt delivery state.
- In WSL Ubuntu-26.04 run focused tests, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Report actual counts and results; do not state unrun checks as passing.
- Use existing pinned Node/npm and repository dependencies only. No installation, network, live source, API key, external service or deployment operation.

## Stop and handoff

Stop if the current schema cannot implement a race-safe reservation without mutating the original outbox, if the sink idempotency contract cannot be enforced at the adapter boundary, if PGlite cannot cover the necessary transaction/role behavior, or if implementation requires an unassigned capability/schema/API change. Report the exact limitation to root.

Commit implementation and handoff in coherent descriptive commits on the assigned branch; do not merge or push. Leave the worktree clean. Handoff must include branch/worktree, exact base, commit SHA(s)/messages, changed paths, behavior, WSL runtime versions and actual checks, limitations, migration/configuration impact and remaining decisions. Root reviews before acceptance/integration.
