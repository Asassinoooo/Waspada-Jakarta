# ADR-005 — Source reuse, archival retention and deletion

- **Status:** Accepted as a source-gated retention design; free-tier backup implementation is unresolved
- **Date:** 24 September 2026
- **Owner:** SPEC-01 team; root planner accepts or revises
- **Requirements:** FR-01/02/03, FR-13, NFR-07
- **Affected documents:** `docs/SOURCE_FEASIBILITY.md`, `REFERENCES.md`; later source registry, ingestion, lifecycle and backup implementation

## Context

The prototype needs traceable evidence and useful history, but a public endpoint or RSS feed does not establish permission to store, transform, embed, or republish its contents. The 24 September bounded probes confirmed that the candidate endpoints respond; they did not establish archival or syndication rights. Several access/reuse rules, rate limits, and backup deletion guarantees still need source-owner or policy review.

## Decision

Treat source approval and content-reuse approval as separate recorded conditions. A source with unknown rights stays disabled for automated acquisition and content persistence; use an explicitly labelled fixture for the live-looking demo. A moderator-submitted URL is permitted as a review path, but durable excerpts or files still require an allowed source-specific basis. Every acquired revision keeps distinct event/observation, publication, fetch, and explicit validity times.

Use the SPEC-01 retention schedule: no durable raw-source copy by default; where permitted, a temporary parsed file expires within 24 hours (parser-failure quarantine at most 7 days); permitted excerpts/extracted text expire 90 days after the event version stops being current and no later than 365 days after fetch; vectors and caches expire with their source text and are purged from active indexes within 24 hours of deletion/retraction; minimal audit metadata remains 24 months. A 30-day encrypted external backup is a target only if a free storage/export mechanism is selected and its deletion replay is tested. Neon Free alone provides up to six hours or 1 GB of instant-restore history and one manual snapshot; it does not provide the off-provider 30-day backup in this schedule. Shorter source terms or deletion obligations override these defaults. Until a free backup/rebuild and deletion-replay procedure is tested, retain synthetic/historical demo data only; do not enable live-source persistence.

## Alternatives considered

- **Keep full source copies indefinitely:** rejected because access is not a grant of archival rights, increases privacy exposure, and makes deletion difficult.
- **Keep no provenance after publication:** rejected because reviewers need to trace source, time, correction, and decision history. Retain minimal, permission-eligible provenance and non-content audit metadata instead.
- **Enable all public endpoints by default:** rejected because HTTP success does not resolve source authority, rate limits, reuse, or deletion requirements.

## Consequences and open items

Collectors must support source-level disablement, minimal metadata mode, source-revision deletion, vector/cache invalidation, and restore-time deletion tombstones. Public claims whose only eligible evidence is removed must be reviewed or withdrawn; expiry is never incident resolution. A stricter provider term always wins. The proposed durations are engineering defaults, not legal advice or a finding that any listed provider permits that retention. The current Cloudflare/Neon Free profile is a demo target and does not yet meet the external-backup target.

Before live activation, the team must record current BMKG and PetaBencana access/attribution limits, ANTARA and Korlantas RSS/article reuse conditions, issuer-specific rules for group notices and sensitive student data, and a no-cost backup provider's region and deletion behavior. Acceptance of this design does not approve any source's reuse rights. Until those reviews and a restore/deletion rehearsal are complete, affected automated connectors remain off and demos use labelled fixtures.
