# Architecture decision register

Record a short ADR for consequential changes before dependent implementation. Include context, decision, alternatives, trade-offs, status, date, owner and affected requirements/files. Use proposed, accepted, superseded or rejected; a proposal is not a completed implementation.

## Baseline constraints

The user has requested a five-layer architecture, orchestration confined to L3, Responsible AI across layers, Google Docs for the report, and root planning/review with **gpt-6-luna / max** implementation subagents. These constraints do not require reapproval in each task.

## Decisions to close

| ID | Decision | Current working position | Owner / deadline |
| --- | --- | --- | --- |
| ADR-001 | Deployment topology and reference workload | Proposed single Linux VPS; separate API/worker/database processes; hosted AI; 4 vCPU / 16 GB / 100 GB starting estimate | Root + Jesaya, BOOT-01 |
| ADR-002 | Job queue and orchestration persistence | Proposed PostgreSQL durable jobs with LangGraph only for investigation state; specify leases, cancellation and usage reservations | Jesaya + Perry, JOB-01 |
| ADR-003 | Domain states, publication and evidence assessment | Separate lifecycle/freshness/evidence/relevance; specify evidence-assessment eligibility and disputed-claim transitions | Root + team, SPEC-02 / PUB-01 |
| ADR-004 | Model/provider and embedding dimensions | Separate capability adapters; choose actual versions after Indonesian-case quality/cost/latency comparison; no initial fine-tuning | Perry, AI-01 |
| ADR-005 | Source reuse, archival retention and deletion | Approved source matrix; keep only permitted content; define derivative and backup expiry | Team, SPEC-01 before live ingestion |
| ADR-006 | Moderator authentication and authorization | Public browsing anonymous; moderator/admin roles protected by server-side checks; concrete session/auth approach TBD | Jesaya, SPEC-03 / MOD-01 |
| ADR-007 | Map tiles, place gazetteer and geocoding | Leaflet UI; licensed boundary/gazetteer source and map/geocoding provider not yet selected; ambiguous place stays unresolved | Jesaya + Rasya, SPEC-03 / DATA-02 |
| ADR-008 | Cost ceilings and hosted deployment | Per-investigation bounds fixed in baseline; daily/monthly spending, provider account, hosting region and backup service TBD | User/team, before paid/live enablement |
| ADR-009 | Evaluation thresholds and retention of held-out cases | Casebook and required failure gates defined; model thresholds and representative workload need measured baseline | Team, EVAL-01 / RAG-01 |

Resolve decisions at the indicated dependency boundary; fixtures and unrelated planning can continue. Do not silently make a billable provider or public-launch decision on the user's behalf. Record routine reversible engineering decisions in the ADR without adding unnecessary approval steps.
