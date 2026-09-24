# ADR-003 — Domain states, evidence references and publication gate

- **Status:** Accepted as a design baseline on 24 September 2026; runtime validation remains implementation work.
- **Owners:** Team 12
- **Scope:** SPEC-02, PUB-01; FR-03/06/08/13 and NFR-01/05

## Context

The original agent-first concept mixed source intake, event truth, freshness and publication inside a general orchestration loop. The revised five-layer design needs distinct L1 data records, L2 grounded proposals, L3 gap investigation, L4 publication authority and L5 evaluation. The domain model must preserve conflicting evidence and corrections without implying that retrieval or model confidence proves a claim.

## Decision

Use the proposed `schema_version: 2.0` contracts in [contracts.schema.json](../contracts.schema.json), examples in [contracts.examples.json](../contracts.examples.json), and detailed invariants in [DOMAIN_MODEL.md](../DOMAIN_MODEL.md). Treat this schema as a versioned boundary design, not a database migration or implemented runtime validator.

- L1 owns source/revision/origin/geometry/chunk/embedding/extraction records. Source registry approval and revision eligibility remain distinct; L1 acquisition is configured by source policy, not started by the L3 agent.
- L2 creates a typed `GroundingContext` and claim-level `EventProposal` from time-, spatial-, identity-, audience-, and semantically retrieved evidence. Each evidence reference binds to an immutable permitted text hash and exact Unicode code-point span. Unknown or contrary evidence is retained.
- L3 opens only when grounding identifies a measurable gap. A checkpoint retains the investigation ID, event/version pair and finite usage ledger across resumes. Budget maxima remain 5 tool attempts, 4 reasoning turns, 60 active seconds and 12,000 input/output tokens; service logic also enforces each configured case budget.
- L4 alone writes immutable versioned `Event` and `Impact` records and `PublicationDecision`s. Directly grounded and investigated proposals use the same rule set. Decisions are claim-specific, check source eligibility and evidence references, recheck current event versions, and can reject/hold without creating an event. Moderators cannot bypass the gate.
- Keep event/impact lifecycle, information freshness, claim evidence assessment, source revision eligibility, publication status and user relevance as separate dimensions. A stale or expired warning is not equivalent to a resolved event or safe condition.
- A withdrawal creates a minimal tombstone and invalidates derived indexes/caches; historical records and audit data preserve provenance without reinstating withdrawn evidence as current. Storage and deletion follow ADR-005.
- L5 may surface quality metrics and reviewed improvement candidates but cannot silently change a model, threshold, source approval or publication rule.

## Public and review projections

The public API returns only published event projections. It resolves internal evidence references to permitted source attribution and omits internal offsets, unpublished text, model runs and private moderation data. The moderator API includes permission-eligible evidence spans, origin relations and version state needed for review. Both projections are separately described by SPEC-03; neither changes the domain contract or gives the browser authority to publish.

## Trade-offs and validation

Immutable versions and distinct state dimensions add records and joins but support correction, expiry and audit. The closed schema catches structural mistakes but cannot establish that prose entails a claim, that a source is truly independent, or that coordinates have the intended real-world meaning. L4 service checks, source policy and human review remain required.

Root validated the JSON Schema as Draft 2020-12 and checked all 14 synthetic examples against the `oneOf` contract: all passed on WSL. DATA-01 must add referential, hash/span, time, source-policy, geometry and concurrency checks. PUB-01 must test disputed claims, withdrawal, no-result decisions and replay/idempotency. This ADR accepts the design, not runtime behavior.
