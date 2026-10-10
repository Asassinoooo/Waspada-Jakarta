# Web operations dashboard

**Baseline:** 10 October 2026 · Team 12

**Implementation:** [ADMIN-MAP-01](assignments/ADMIN-MAP-01.md), branch `codex/admin-map-dashboard`. The authorized scope is a complete fictional operations demonstration and actual monitoring of existing public endpoints. This specification adds a web client; it does not activate authentication, private telemetry, source acquisition or publication.

## 1. Admin task and user stories

The dashboard answers: **What is visible in this snapshot? Where is it located? Which processing stage is involved? What evidence or failure explains its state? What can be observed from the current system?** Geographic context organizes the workspace, while the linked queue supports cases without a location. Operations priority means work needs attention; it does not mean a place is dangerous.

| User story | Acceptance |
| --- | --- |
| As an operator, I want to select a mapped or unmapped case and inspect its evidence and processing history, so that I can understand its state without losing geographic context. | Map/list selection agree; selected item is in the current filtered snapshot; unmapped cases remain available; geometry provenance and source/event/observation/publication meanings stay explicit. |
| As an operator, I want to see how L1–L5 interact and why a case stopped, so that I can distinguish data preparation, grounded reasoning, bounded investigation and publication review. | Simulation provides varied finite examples, source/gate/stop details and L3 limits; every simulated value stays labelled. L3 is conditional, L4 requires human/deterministic publication checks, L5 observes across layers. Nothing is approved or restarted from this dashboard. |
| As an operator, I want bounded observation of the running public API while this view is open, so that I can recognize response failures or outdated observations without mistaking them for missing incidents. | Actual GET probes show latest attempt, last success and browser duration; polling is visible/online/active only, single-flight, abortable and backed off on failure. Internal queue/model/audit measurements remain unavailable until a protected provider exists. Empty records or maps never imply safety. |

## 2. View organization

- Header: web-only operations context, return to public browsing, explicit read-only scope, observation time and manual/pause controls.
- Mode switch: **Simulasi alur** or **Pantauan API**, with visible provenance. Changing mode cancels previous requests/timers and clears incompatible selection/data.
- Filters: text, processing layer/state and mapping availability. Counts describe the filtered/loaded subset, not a city-wide total.
- Main workspace: linked queue, dominant map coordinate canvas and case inspector. Desktop uses columns; narrow web uses map/list switch plus stacked inspector. Map operation is optional.
- Inspector: title/category, operational stage/status, location/provenance, evidence/source summary, individually labelled times, exact published version when available, process steps and reason for hold/failure. L3 budgets and next step are descriptive, never an authorization action.
- Process overview: five named layers with availability and limited measured values. Sources, activity and probe panels explain where each observation came from and what is not connected.

## 3. Five-layer responsibility

| Layer | Demonstrated in fictional cases | Observable from the present public API |
| --- | --- | --- |
| L1 Data & Knowledge | Source receipt, cleaning/extraction, quarantine, relational/spatial/vector preparation | Public source name/health/last-success metadata only; no raw report, queue, parser or vector-state read |
| L2 Model & Grounding | Retrieval before synthesis, evidence association, contradiction/insufficient grounding | Unavailable: no model runs, quality scores or private retrieval traces |
| L3 Inference & Orchestration | Investigation only for insufficient context, finite tool/reasoning/token/time budgets, human escalation | Unavailable: no private case ledger, tool calls, usage or stop-reason stream |
| L4 Application Integration | Deterministic publication gate and moderator review; held proposals distinguished from published versions | Loaded public event/version/geometry projections; no review mutation or private approval state |
| L5 Evaluation & Monitoring | Cross-layer observation/failure/completion events | Browser-observed context/list/geometry request status/duration; not server latency, model quality, full-stack health or Cloudflare/Neon usage |

Responsible AI applies across the stack: source provenance, isolated external content, minimal allowlisted projections, auditability and human oversight. No raw source content, prompt, credential, unredacted log or model-generated private trace is exposed through public endpoints.

## 4. Geographic meaning

The initial workspace uses a geographic coordinate canvas with labelled longitude/latitude, zoom/pan/fit controls and accessible feature selection. It requests no third-party tiles or fonts. A permitted/versioned basemap or administrative boundary has not been selected; no road network, coastline or district polygon is invented.

ADR-018's CRS84 envelope is a query ceiling only, never a warning area or official administrative boundary. Simulated coordinates/segments/polygons occur exclusively in the labelled simulation. Actual mode renders only returned public geometry whose event ID and version match a loaded public record; multiple geometries retain their coordinates. No location is inferred from text and no danger radius is generated. Geometry outside a current viewport may be reached with fit controls; absence from this snapshot is not proof of safety or coverage.

## 5. Observation, not ingestion

Existing calls: `GET /api/v1/context`, `GET /api/v1/events?limit=20`, `GET /api/v1/events.geojson`. There is no detail/history fan-out, private route, public-contract change or source/model action. First-page truncation, unmapped cases and geometry version mismatches remain visible limitations. These independent reads are not described as an atomic database snapshot.

Default refresh interval is **30 seconds** while the dashboard and tab are active, online and polling enabled. One cycle has at most three public GET calls; manual refresh coalesces with an active request. On failure, bounded backoff limits further requests. Hide/pause/offline/navigation aborts or discards pending work and clears timers. Returning to an eligible state refreshes without accumulating hidden-tab catch-up requests. The client stores no operations snapshot or private authentication token.

Each attempt records its observation time and measured duration separately from the last successful observation. Stale data is never relabelled current by ticking a clock. Context failure makes dataset-dependent records unavailable rather than asserting live/demo mode from a stale prior response. A successful HTTP response establishes endpoint response only, not truth, source availability, model success or overall health.

Server deployment dataset (`live`/`demo`) and record kind (`live`/`historical`/`synthetic`) remain separate from whether the HTTP probe is actual. A real request to the demo Worker is displayed as an actual request to a **demo** dataset, not a current incident feed.

## 6. State and recovery matrix

| Situation | Required explanation and response |
| --- | --- |
| Initial/loading | Explain which observation is pending; no placeholder count presented as measured |
| Empty returned page | State no records were returned in this loaded page; preserve coverage limitations |
| No supported geometry | Keep records in queue and explain they are not mapped |
| Empty/unavailable sources | Empty registry differs from a failed source; no health percentage inferred |
| Partial request failure | Identify the failing endpoint, keep independently valid parts only, expose a retry |
| Repeated failure/stale observation | Distinguish latest failed attempt from previous success and backoff; never refresh source/event time artificially |
| Paused/hidden/offline | Stop polling/simulator; show reason, provide explicit resume/manual refresh when eligible |
| Simulator complete | Stop at the final scripted step; replay is explicit and resets only local demonstration state |
| Unavailable private data | Explain the missing authenticated provider; never fill gaps with zero or fictional values |

## 7. Access and release boundary

The visible admin demonstration is intentionally account-free, synthetic and read-only. It is not an authenticated administrator session. Opening its route must not reveal private records or alter source/publication/rights gates. Existing read-only moderator behavior under ADR-028 remains intact, and Flutter receives no operations route or functionality.

Actual private operations require a separate assignment for verified server-side identity, admin role/dataset scope, bounded least-privilege projections, retention/redaction, audit and runtime integration. That release must never trust request-provided role headers or browser-stored administrator tokens. Hosted free-tier capacity and private telemetry delivery remain unverified; this local client enables no external service.

Acceptance evidence is recorded in the assignment/handoff after meaningful WSL tests, integrated checks and headless visual/keyboard/large-text inspection. Human usability, manual screen-reader audit, live source rights, private telemetry and hosted performance are separate gates.
