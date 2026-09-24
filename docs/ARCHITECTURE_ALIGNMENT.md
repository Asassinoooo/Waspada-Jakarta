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

## Implementation boundaries still to deliver

- Source adapters, relational/spatial/vector migrations and access-controlled storage.
- Extraction/embedding/reasoning adapters and measured provider/model selection.
- Hybrid retrieval, support assessment and real semantic-grounding evaluation.
- Persistent investigation counters, cancellation, safe tool execution and moderator escalation.
- Publication transactions, outbox/correction propagation and public/moderator interfaces.
- Telemetry and held-out incident evaluation. Numeric budgets and retrieval limits remain proposed configuration values, not measured guarantees.

Contract examples are wholly synthetic. Schema validation can reject malformed structure but cannot establish source authenticity, evidence independence, semantic support, geometry truth, authorization or cross-record consistency. Those checks belong to the implementation and its future integration tests.

## Revision checks

- Draft 2020-12 schema checked with format validation: all six record examples accepted; ten malformed examples rejected, including unsupported publish fields, missing evidence, exceeded budgets, wrong types and malformed timestamps.
- Google Doc read back after editing: seven chapter sections, three user stories, five layer descriptions and the replacement diagram; no internal file references or numbered citations. All 11 exported pages inspected visually.
- Updated 12-slide deck passed package, declared layout and re-import checks; all slides inspected visually. The inherited timeline grid generated a footer-overflow heuristic warning, but the rendered grid, labels and footer do not overlap.
- No application code or model evaluation was run or claimed. No LaTeX compiler was installed or used for this revision.
