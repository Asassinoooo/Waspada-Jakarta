# Architecture alignment record

Date: 18 September 2026. Scope: current project plans, chapter-one Google Doc, architecture and contracts, diagrams and kickoff presentation. The user-supplied five-tier image is the organizing framework, not evidence of implementation.

| Audit finding | Alignment |
| --- | --- |
| Ingestion, extraction and source acquisition were described inside an agent workflow | L1 now owns a dedicated pipeline, immutable revisions, spatial metadata and embeddings; it may call a fixed L2 extraction adapter without autonomy |
| Model choice and retrieval were implicit | L2 distinguishes extraction, embeddings and reasoning; initial grounding combines identity, spatial/time, audience and semantic retrieval |
| The coordinator was the architecture's main organizing unit | L3 is conditional on remaining evidence gaps; new material returns through L1/L2 |
| Research limits varied between descriptions | All current descriptions use the proposed 5-tool / 4-turn / 60-active-second / 12,000-token limits; resume and retries preserve/count usage |
| Model verification and publication authority were blurred | Both proposal paths use L4 backend rules, version checks and human review; JSON validity is not proof of semantic support |
| Evaluation concentrated on the end result | L5 covers every layer, including retrieval recall, index freshness, model cost and investigation traces |
| Team tasks and milestones followed an agent-first sequence | Owners and relative weeks now deliver data/contracts, grounding, bounded investigation, integration and evaluation in dependency order |

The Google Doc retains its seven required sections, three representative user stories, university report formatting and team roster. It contains no internal file references or numbered in-text citations. The report remains concise; the detailed module boundaries and contracts live in the local design specifications.

The original course lecture deck is reference material and is unchanged. Earlier LaTeX deliverables are retired from active maintenance at the user's request. The earlier kickoff deck is retained as an input/history file; the Layered deck is its current replacement.

## Initial gaps recorded on 18 September 2026

- Source adapters, relational/spatial/vector migrations and access-controlled storage.
- Extraction/embedding/reasoning adapters and measured provider/model selection.
- Hybrid retrieval, support assessment and real semantic-grounding evaluation.
- Persistent investigation counters, cancellation, safe tool execution and moderator escalation.
- Publication transactions, outbox/correction propagation and public/moderator interfaces.
- Telemetry and held-out incident evaluation. Numeric budgets and retrieval limits remain proposed configuration values, not measured guarantees.

Contract examples are wholly synthetic. Schema validation can reject malformed structure but cannot establish source authenticity, evidence independence, semantic support, geometry truth, authorization or cross-record consistency. Those checks belong to the implementation and its future integration tests.

## 18 September 2026 revision checks

- Draft 2020-12 schema checked with format validation: all six record examples accepted; ten malformed examples rejected, including unsupported publish fields, missing evidence, exceeded budgets, wrong types and malformed timestamps.
- Google Doc read back after editing: seven chapter sections, three user stories, five layer descriptions and the replacement diagram; no internal file references or numbered citations. All 11 exported pages inspected visually.
- Updated 12-slide deck passed package, declared layout and re-import checks; all slides inspected visually. The inherited timeline grid generated a footer-overflow heuristic warning, but the rendered grid, labels and footer do not overlap.
- No application code or model evaluation was run or claimed. No LaTeX compiler was installed or used for this revision.

## 24 September 2026 — layered contracts and free-tier deployment

The current architecture retains the five-layer boundaries above and replaces the earlier single-host/FastAPI proposal with a no-spend Cloudflare Workers + Neon Free target. See [ADR-010](decisions/ADR-010-cloudflare-neon-free.md). This target is explicitly limited to a low-volume class demo; scale-to-zero, quota failures, the 0.5 GB Neon storage cap and missing 30-day off-provider backup prevent a live-coverage or high-availability claim.

SPEC-02 now uses schema 2.0 with 14 synthetic record examples. Root accepted ADR-003 and checked the examples against the JSON Schema on WSL. SPEC-03 now defines a separate OpenAPI 3.1 application projection; its schema mapping omits private text offsets from public responses and preserves evidence references in moderator views. Runtime implementation and cross-record semantic checks remain for later tasks.

The default planner/implementer model remains Luna Max; Astra xhigh is reserved for a substantive technical issue attempted and unresolved by Luna, not an account usage limit. Future agents must work in dedicated branches/worktrees and commit each coherent work package with descriptive messages. The initial three spec drafts were already written in the shared checkout before that requirement; they stopped on usage limits before committing, and their history has not been rewritten. Future project tests will use WSL Ubuntu-26.04. Current local checks include YAML/OpenAPI shape, local references, JSON Schema structure and synthetic example validation; no app runtime or external service is involved.

## 26 September 2026 — current implementation status

The five-layer ownership model remains the project baseline. Locally tested components now include L1 fixture parsing, text/chunk preparation, revision/evidence/geometry persistence and queue-to-fixture processing; L2 typed adapters, hybrid retrieval, a least-privilege reader, exact selected-span rehydration, schema 2.0 context assembly and persistence, validated bridge, conditional direct reasoning and bounded retrieval/reasoning telemetry; the L3 bounded-investigation ledger and its privacy-safe write telemetry; and L4 publication policy, public projection and manual-write transaction. L5 includes synthetic casebook tooling and privacy-safe API request telemetry with route/status/duration fields at 1% sampling, plus safe L2 retrieval outcome summaries, L2 direct-reasoning outcome/duration, and bounded L3 ledger transition summaries. L2 and L3 telemetry remain no-op unless explicitly injected, and there is no Worker/database runtime composition path enabling them. Human-adjudicated evaluation, quality/cost/source-health measurements and full production monitoring remain future work. The structured console events use explicit allowlists and invocation URL logs are disabled, but no Worker deployment or remote collection check has occurred. The direct reasoning seam persists context before branching, bypasses the reasoner for caller-insufficient context, and passes typed outcomes through for sufficient context. The next assigned L3 entry slice links that explicit investigation handoff to the existing bounded ledger; it does not execute tools or call a planner.

Root independently passed the focused L2 assembly DB/Worker tests (14/14 and 6/6), direct-reasoning test (9/9), and full WSL workspace suite (188/188: web 5, Worker 93, DB 78, casebook 12), typecheck, build and diff checks. These results establish local component behavior only. The Worker has no database-session or hosted Neon wiring, no live connectors or model provider are enabled, source/data rights and human review labels are pending, and no moderator or public database-backed HTTP route is complete. Keep the 30-day off-provider backup and deletion-replay requirement as a live-data gate. The five layers are logical boundaries within the selected modular Worker and data platform, not five deployed services.
