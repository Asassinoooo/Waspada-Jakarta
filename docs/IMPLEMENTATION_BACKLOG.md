# Implementation backlog

Baseline: 24 September 2026. All implementation tasks are planned; no runtime work has started. The root planner changes statuses after actual review. Requirements refer to [the SDP](../SOFTWARE_DEVELOPMENT_PLAN.md). PLAN-00 received a GPT-6 Luna/max gap review and final consistency review, followed by root acceptance. The local repository's origin is https://github.com/Asassinoooo/Waspada-Jakarta.git.

| ID | Work package | Depends on | Requirement coverage | Acceptance/handoff | Status |
| --- | --- | --- | --- | --- | --- |
| PLAN-00 | Repository and master plan | — | Delivery governance | Local Git baseline, GitHub origin, SDP, agent rules and indexed backlog | accepted |
| SPEC-01 | Source feasibility and retention matrix | PLAN-00 | FR-01/02/03; NFR-07 | Source access, permissions/attribution, data fields, timestamps, polling, storage/retention, failure behavior; live/manual/demo mode and fixture fallback explicit | planned |
| SPEC-02 | Domain model, state transitions and schemas | PLAN-00 | FR-03/06/08/13 | ER diagram; source/origin/geometry/event/impact/checkpoint records; taxonomy/tags; embedding metadata; limits versus usage counters; time/ID/version/state rules | planned |
| SPEC-03 | UI flows and API contract | SPEC-02 | US-01/02/03; FR-09–12 | Map/feed/detail/preferences/moderation wireframes, error states, endpoint/auth/pagination/filter shapes | planned |
| EVAL-01 | Labelled casebook and split manifest | SPEC-01, SPEC-02 | NFR-01; FR-15 | >=40 reports / >=12 cases; two reviewers reconcile labels; incident-level splits; demo provenance | planned |
| BOOT-01 | Runtime and application skeleton | SPEC-02, SPEC-03 | NFR-08 | Proposed apps/web, apps/api, workers, tests, infra structure; version locks, environment example, startup instructions, no secrets | planned |
| UI-00 | Early application slice against reviewed fixtures | BOOT-01, SPEC-03 | US-01/03; FR-10/12/15 | Weeks 3–4 feed/detail/map shell and read-only moderator fixtures; demo labels; MOD-01 authorization before any real review mutation; full integration remains UI-01/03 | planned |
| DATA-01 | DB migrations and repository interfaces | BOOT-01, SPEC-02 | FR-01/03/14 | Relational/spatial/vector schema, role permissions, migrations, source registry and trace linkage | planned |
| JOB-01 | Scheduler and durable job queue | DATA-01 | FR-02/13; NFR-05 | Unique keys, leases, retries/backoff, restart recovery, worker concurrency and source-health tracking | planned |
| ING-01 | Structured weather/disaster connectors | JOB-01, SPEC-01, EVAL-01 | FR-02/03/04/15 | BMKG and PetaBencana parsing with real timestamp semantics; approved access; historical fixture replay distinct from live | planned |
| ING-02 | News/traffic and moderator URL acquisition | JOB-01, SPEC-01 | FR-02/03/12 | ANTARA discovery and one approved traffic source; bounded page parsing, allowlisted redirects, content hashing | planned |
| AI-01 | Model capability adapters | DATA-01, EVAL-01 | FR-04; NFR-02 | Extraction/embedding/reasoning interfaces, strict validation, usage accounting, mocks, provider benchmark and selected versions | planned |
| DATA-02 | Normalization, chunks, entities and indexes | ING-01, AI-01 | FR-03/04/06 | Stable offsets, gazetteer candidates, audience fields, embedding version/hash, invalidation and privacy filtering | planned |
| RAG-01 | Hybrid retrieval and grounded proposals | DATA-02, EVAL-01 | FR-05/06/07 | Exact/spatial/time/audience/semantic candidates; contradictory evidence; measured recall; sufficient cases produce direct proposals | planned |
| PUB-01 | Publication policy and event version service | DATA-01, SPEC-02, EVAL-01 | FR-08/09/13; NFR-01/05 | Fixtures exercise approved sources, support/review rules, scope, versions, transactions and outbox; auto-publication initially disabled | planned |
| API-01 | Public published-event endpoints | PUB-01, SPEC-03 | FR-09/10 | Bounded filters/pagination, published-only GeoJSON/list/detail/history, documented error behavior | planned |
| MOD-01 | Moderator authentication and review API | PUB-01, SPEC-03 | FR-01/08/12 | Protected source/review/correction/retraction actions, authorization and audit trail, no model-issued approvals | planned |
| UI-01 | Map, feed and event detail | API-01, SPEC-03 | US-01; FR-09/10/15 | Responsive views, evidence/time/status labels, manual location selection, list fallback and demo labels | planned |
| UI-02 | Preferences, briefing and update centre | UI-01 | US-02; FR-11 | Local interests, deterministic relevance reasons, eligible-claim summaries, duplicate suppression and corrections | planned |
| UI-03 | Moderator workspace | MOD-01, SPEC-03 | US-03; FR-12 | Side-by-side evidence/origin/history, conflicts, decision reasons and reviewed correction flow | planned |
| AGENT-01 | Tool executor and bounded coordinator | RAG-01, JOB-01, ING-02, PUB-01 | FR-07/08; NFR-02/07 | Durable counters and reservations, approved tools, source-to-L1/L2 return, no-progress/limit escalation, bypass and restart cases | planned |
| LIFE-01 | Freshness and correction propagation | JOB-01, PUB-01, UI-02 | FR-11/13 | Distinct lifecycle/freshness transitions, expiry, retraction, cache/vector invalidation, idempotent outbox delivery | planned |
| OBS-01 | Monitoring and evaluation integration | BOOT-01; continues across tasks | FR-14; NFR-04 | Trace fields available from early tasks; quality/cost/latency/source-health views completed after RAG/agent integration | planned |
| INT-01 | Four complete scenarios | ING-01/02, RAG-01, AGENT-01, UI-01/02/03, LIFE-01 | All Must FRs | Direct and investigated paths, independent claims/effects, non-geographic case, outage and correction behavior | planned |
| RELEASE-01 | Deploy, restore and evaluate | INT-01, OBS-01, EVAL-01 | NFR-01–08 | Reference-host workload, usability findings, held-out evaluation, deployment/rollback/restore guide and root acceptance | planned |

## Assignment template

```text
Task ID and objective:
Implementation agent: gpt-6-luna / max
Assigned branch/worktree and allowed paths:
Read first / relevant requirement IDs:
Inputs and required dependency outputs:
Interface/schema version and forbidden boundary changes:
Acceptance scenarios:
Verification commands and allowed external calls/budget:
Escalate to root if:
Handoff: changed files, behavior, actual results, limitations, migrations/configuration.
```

The root resolves shared interfaces before dispatch and reviews diffs plus verification evidence after handoff. Split large packages into bounded subtasks without losing parent requirement links. Live integration, UI scaffolding against fixtures and backend policy may progress independently where contracts permit. Do not parallelize edits to the same migration, lockfile or contract without an explicit owner.

OBS-01 is a continuing integration package: each task implements its own telemetry immediately, so nobody waits for a late monitoring task to add trace IDs. EVAL-01 supplies fixtures before model tuning. Public-facing UI can begin with reviewed contract fixtures while API implementation is in progress; final acceptance still requires the real API.
