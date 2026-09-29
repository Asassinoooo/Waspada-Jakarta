# ADR-030 — Privacy-safe durable investigation progress

- **Status:** Accepted for local implementation
- **Date:** 29 September 2026
- **Owner:** Root planner
- **Requirements:** FR-07; NFR-02/05/07
- **Related work:** ADR-014, ADR-017, ADR-027, ADR-029, AGENT-01

## Context

Layer 3 already persists per-case budgets, reservations, tool names/outcomes, reasoning usage, and versioned grounding-context identity. It deliberately does not persist action arguments or source text. That means a future bounded coordinator cannot yet prove across a process restart that a proposed lookup is unchanged, or that two consecutive retrievals added no usable grounding evidence. Keeping these decisions only in local variables would allow a resumed workflow to repeat work or reset its no-progress counter.

Schema 2.0 `InvestigationCheckpoint` is a stable external/internal record contract and must not grow raw action inputs or model-derived evidence text. L3 needs an additional internal persistence boundary that preserves the current data-minimization rule.

## Decision

- Give each investigation a fingerprint-key identifier resolved by trusted Worker configuration. Its secret key is never written to SQL, fixtures, logs, telemetry, or commits. Missing key material fails closed before a model or tool action. Local tests use an explicitly synthetic key.
- Before reserving a registered tool action, canonicalize the validated typed input and compute an HMAC-SHA-256 digest with domain separation over dataset, investigation, action name and input. Store only the 32-byte digest and key identifier on the durable reservation. A case-scoped unique constraint prevents an exact unchanged lookup from being reserved again. The input and secret key are never persisted.
- Compute a separate HMAC-SHA-256 grounding digest from a closed projection of stable L2 context metadata: evidence/source/revision identities and statuses, evidence offsets and relations, origin independence, candidate event versions, prior decision identities, and unresolved-field/conflict labels. Exclude report excerpts, raw URLs, prompts, model output, and volatile retrieval time. Store only the digest and key identifier.
- Record an initial grounding digest when opening an investigation, then append one progress snapshot after each refreshed context is durably persisted and attached to the current checkpoint. A digest equal to the preceding snapshot increments the consecutive no-progress count; a changed digest resets it. Two successive unchanged refreshes stop the investigation for review. Replaying the same checkpoint-version update returns the existing snapshot.
- Keep fingerprint and progress records dataset-scoped, case-scoped, append-only, and available only through the narrow L3 database capability. They supplement, but do not replace, the ledger checkpoint and budget counters. The fingerprint key ID is pinned per case; key rotation must retain the corresponding key for active or paused cases. Legacy cases without a fingerprint key cannot continue autonomously and must fail closed for review.
- Keep orchestration, source access, evidence acquisition, context construction and publication outside this persistence slice. New material still returns through L1 and L2; L4 publication authorization is unaffected.

## Consequences

Restarted L3 work can reject an exact repeated action and carry a no-progress streak forward without retaining model-generated queries, URLs, report contents, or evidence excerpts. Persisted digests remain linkable within their case and must be treated as sensitive operational metadata. HMAC keys require deployment-time secret management; this ADR does not select or configure an external provider, set a production secret, enable a live source, or authorize live autonomous actions. Public schema 2.0 and all public API contracts remain unchanged.

The first implementation slice adds the internal fingerprint and progress repository, an injected Worker-side HMAC implementation, and synthetic PGlite coverage. A later coordinator task will consume the repository. Hosted Neon behavior and secret rotation procedures remain unverified.

## Alternatives considered

- **Persist raw tool inputs or evidence snapshots:** rejected because it unnecessarily retains query text, URLs, report material and possible personal data.
- **Keep repeat/no-progress state only in process memory:** rejected because a restart could forget attempted actions or reset the no-progress limit.
- **Use an unkeyed hash of action inputs:** rejected because common searches and URLs can be guessed offline from the digest.
- **Change the schema 2.0 checkpoint contract:** rejected because these are internal coordination facts, not public/domain claims.

## Affected files and requirements

Future implementation is expected in a new append-only SQL migration, the typed investigation ledger repository, the L3 fingerprint adapter, and focused PGlite/Worker tests. Covers FR-07 and NFR-02/05/07.
