# ADR-022 — PostgreSQL driver for Cloudflare Workers

- **Status:** Accepted for the local adapter implementation; provider runtime remains unverified.
- **Date:** 27 September 2026
- **Owners:** Team 12; platform implementation led by root
- **Scope:** Worker-side SQL adapter over the existing `SqlExecutor` interface.

## Context

The repository now has database repositories behind the portable `SqlExecutor` interface, and ADR-010 selects Cloudflare Workers + Neon Free with Hyperdrive. A Worker-side PostgreSQL driver adapter is needed before the accepted public read services can be composed with a runtime database connection. No Neon project or Hyperdrive binding has been created.

Cloudflare's current Neon integration guide recommends Hyperdrive and says Workers should use a native PostgreSQL driver such as `pg` or Postgres.js rather than Neon’s serverless driver when using Hyperdrive. Cloudflare's current driver guide recommends node-postgres and lists `pg` 8.16.3 as the minimum supported version. Source links and review date are in [REFERENCES.md](../../REFERENCES.md).

## Decision

Implement the Worker-side PostgreSQL adapter with node-postgres (`pg`) and accept the Hyperdrive-provided connection string as an explicit input. The adapter will expose the existing `SqlExecutor` query/execute contract, use parameterized values, scope a client to one injected operation, and close the client when that operation finishes or fails. Keep SQL connection setup separate from Layers 1–5 orchestration and application policy.

The adapter task does not read Worker bindings or credentials, create a Hyperdrive resource, change `WorkerEnvironment`, or activate database-backed routes. Runtime composition will later inject the Hyperdrive binding and construct the read services. Continue using the synthetic demo default until an explicit runtime assignment wires those dependencies. Local tests use fake clients and no provider connection.

## Alternatives and trade-offs

- **Neon serverless driver with Hyperdrive:** Cloudflare specifically recommends native drivers with Hyperdrive, so this is not selected for that path.
- **Direct Neon connection from each Worker invocation:** possible, but repeats connection setup and forgoes Hyperdrive's shared pooling; provider latency and capacity remain unmeasured.
- **Postgres.js:** supported by Cloudflare, but node-postgres is the current recommended driver and fits the existing `SqlExecutor` boundary.

The selected dependency adds bundle size and requires a Workers-compatible Node.js runtime surface. The project compatibility date is `2026-09-24`; the implementation must prove the Wrangler dry-run works, but that check does not establish a deployed Neon connection. Queries remain subject to the Free-tier Hyperdrive statement limit and Neon compute/storage/transfer limits already recorded in ADR-010.

## Acceptance and limits

The local adapter must preserve parameterized reads, execute statements, and client cleanup under success and failure, with typed rows passed through without exposing driver diagnostics at the public API boundary. Tests use a fake driver client. Hosted Hyperdrive/Neon connectivity, SQL limits, TLS, query latency, and provider-side connection pooling remain unverified and require a later bounded runtime task. This ADR authorizes no external resource creation or deployment.

Affected requirements: NFR-01, NFR-07. Related decisions: [ADR-010](ADR-010-cloudflare-neon-free.md), [ADR-021](ADR-021-public-event-list-cursor.md).
