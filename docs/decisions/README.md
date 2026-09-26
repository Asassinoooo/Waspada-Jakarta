# Architecture decision register

Record a short ADR for consequential changes before dependent implementation. Include context, decision, alternatives, trade-offs, status, date, owner and affected requirements/files. Use proposed, accepted, superseded or rejected; a proposal is not a completed implementation.

## Baseline constraints

The user has requested a five-layer architecture, orchestration confined to L3, Responsible AI across layers, Google Docs for the report, WSL for local project verification, gpt-6-luna/max implementation agents on their own branches with commits, and a no-spend Cloudflare Workers + Neon Free deployment target. These are current constraints; model/provider choices, free-tier compatibility and live-source rights remain open. Usage limits do not justify escalation to Astra.

## Decisions to close

| ID | Decision | Current working position | Owner / deadline |
| --- | --- | --- | --- |
| [ADR-001](ADR-001-single-server-prototype.md) | Historical single-server proposal | Superseded by ADR-010; no VPS purchased or deployed | Closed |
| [ADR-002](ADR-002-job-queue-and-scheduler.md) | Job queue and scheduler boundary | PostgreSQL job rows are authoritative; later Cron/Workflows only trigger bounded work; idempotency, leases, retry cap and source health are explicit | Accepted for JOB-01 |
| [ADR-003](ADR-003-domain-publication-evidence.md) | Domain states, evidence and publication | Accepted schema 2.0 design; PUB-POLICY-CORE and API-PROJECT-CORE are accepted local L4 kernels; transaction/full-service integration remains | Root accepted; PUB-WRITE-CORE / PUB-01 |
| ADR-004 | Model/provider and embedding dimensions | Separate capability adapters; evaluate only no-cost-accessible models and compare Indonesian accuracy, latency, quota and failure behavior; no fine-tuning | Perry, AI-01 |
| [ADR-005](ADR-005-source-retention.md) | Source reuse, archival retention and deletion | Accepted source-gated schedule; permissions and free off-provider backup/deletion replay block live activation | Team, before live data |
| [ADR-006](ADR-006-moderator-auth.md) | Moderator authentication and authorization | Accepted design: server-side sessions, CSRF, roles, audit, dataset scope, concurrency and idempotency; provisioning/MFA/parameters remain open | Jesaya, MOD-01 |
| ADR-007 | Map tiles, place gazetteer and geocoding | Leaflet UI; licensed boundary/gazetteer source and map/geocoding provider not yet selected; ambiguous place stays unresolved | Jesaya + Rasya, SPEC-03 / DATA-02 |
| ADR-008 | Cost ceilings and hosted deployment | No-spend Free-tier path selected by ADR-010; no paid model, upgrade or fallback. Platform quota stop thresholds and any later paid alternative remain outside this baseline | Root + team, PLATFORM-01 |
| ADR-009 | Evaluation thresholds and retention of held-out cases | Casebook and required failure gates defined; model thresholds and representative workload need measured baseline | Team, EVAL-01 / RAG-01 |
| [ADR-010](ADR-010-cloudflare-neon-free.md) | Cloudflare Workers + Neon Free target | Accepted as a low-volume class demo target; no provider resources deployed. Verify quotas, extensions, latency, model allowance, data cap and backup before live scope | Root + team, PLATFORM-01 / RELEASE-01 |
| [ADR-011](ADR-011-l2-grounding-reader.md) | Least-privilege Layer 2 retrieval reader | Accepted local NOLOGIN role with query-required column reads; hosted connection membership remains unverified | Accepted; RAG-ACCESS-01 |
| [ADR-012](ADR-012-public-projection-boundary.md) | Public API projection boundary | Internal `record_json` is untrusted; L4 validates and constructs the unchanged EventView through an allowlist | Accepted; API-PROJECT-CORE |
| [ADR-013](ADR-013-publication-write-transaction.md) | Manual publication write transaction | Decision, event/impact rows, audit, idempotency receipt and minimal outbox commit atomically; no auth or auto-publication | Accepted for local implementation; PUB-WRITE-CORE |
| [ADR-014](ADR-014-l3-investigation-ledger.md) | Durable bounded investigation ledger | Stable case identity, refreshed same-candidate L2 contexts, preflight action reservations, exact reconciliation, append-only checkpoint snapshots and a least-privilege L3 role | Accepted for local implementation; L3-LEDGER-CORE |
| [ADR-017](ADR-017-l3-single-step-execution.md) | Bounded single-step investigation execution | One validated registered action per invocation, durable reservation before start, exact replay without reinvocation, closed reconciliation, no loop or live capability | Accepted for local synthetic implementation; L3-SINGLE-STEP-EXECUTOR-CORE |

Resolve decisions at the indicated dependency boundary; fixtures and unrelated planning can continue. Do not silently make a billable provider or public-launch decision on the user's behalf. Record routine reversible engineering decisions in the ADR without adding unnecessary approval steps.
