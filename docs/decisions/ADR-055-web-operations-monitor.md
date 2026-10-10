# ADR-055 — Web-only read-only operations monitoring

- **Status:** Accepted design; implementation under ADMIN-MAP-01
- **Date:** 10 October 2026
- **Owner:** Team 12 / root planner

## Decision

Build a map-oriented web operations workspace with two isolated modes: a complete labelled fictional process demonstration and actual observation of existing public endpoints. Team 12 selected this scope instead of adding private authentication/monitoring in this wave. Keep account-free public browsing and ADR-028's read-only moderation boundary.

The demonstration explains all five layers and bounded, conditional investigation. Actual monitoring exposes only independently observed public context/list/geometry results and browser request facts. Private source reports, model/tool usage, queues, audit logs and server/provider performance remain unavailable until a separately authenticated, least-privilege projection exists. No fake zeros or simulator measurements fill those gaps.

## Three technical decisions and trade-offs

1. **Native coordinate canvas before a licensed basemap.** SVG uses returned or explicitly simulated CRS84 geometry and has linked list/keyboard alternatives. This avoids a new tile service, dependency, third-party visitor request or fabricated boundary; orientation is less familiar than street maps. A licensed/versioned basemap is a later design and privacy decision.
2. **Bounded polling before a streaming backend.** Existing GET endpoints refresh every 30 seconds only while active, visible, online and enabled; single-flight, cancellation and backoff cap work. This adds no source/model trigger or new server integration, but observation is sampled rather than continuous push telemetry. Browser duration is not server/model latency, and reads are not an atomic full-system snapshot.
3. **Strict mode separation before private operations integration.** Simulation can explain private process states without exposing them publicly. Actual mode has smaller coverage and explicitly unavailable values. A future admin provider needs verified identity/role/dataset scope, redacted typed projections, retention/audit and hosted testing; an unverified client flag or request header can never establish authority.

## Consequences and gates

Flutter has no admin port. The dashboard can inspect and filter; it cannot approve, publish, retry a pipeline job, enable a source or call a model. Current public data may still be synthetic/demo despite actual HTTP monitoring. Public geometry must match exact loaded event/version; simulation never becomes a source or danger zone. No empty map or healthy HTTP response implies area safety.

The [dashboard specification](../ADMIN_DASHBOARD_SPEC.md) and [assignment](../assignments/ADMIN-MAP-01.md) define stories, ownership and checks. Private monitoring, source rights, manual accessibility/human usability, and hosted free-tier behavior remain separate gates.
