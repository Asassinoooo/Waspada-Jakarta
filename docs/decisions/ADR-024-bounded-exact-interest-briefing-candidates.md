# ADR-024 — Bounded exact-interest briefing candidates

**Status:** Accepted, 27 September 2026

## Context

The existing `/briefings` response has a maximum of 100 items and no pagination field. The accepted L4 briefing projector matches an already projected exact-live `EventView` against transient interests: exact categories and NFC-normalized, trimmed, Indonesian-locale case-insensitive scope names from event, published claim, and linked impact scopes. Scanning an arbitrary recent event page could omit older matching events while returning an apparently complete, empty or partial briefing.

## Decision

Select candidates from the current-public live event set by exact category or approved scope-name match across event, claim, and current linked impact scopes. Use only existing least-privilege public views, including approved `public_scope_names`; do not expose private names or identifiers in the response. Apply matching before deterministic order by initial publication time descending and event ID ascending.

The candidate reader returns at most 100 event identities and exact current versions. It probes the 101st row and fails the whole request on overflow; it never truncates a partial briefing or treats overflow as no matches. The future route re-reads/projects the exact candidate versions through the existing L4 public projection and rechecks each match with `API-BRIEFING-PROJECTION-CORE`. A withdrawn latest event remains absent through the current-public views; withdrawn versions and all history after latest withdrawal stay hidden.

The database-side candidate predicate must preserve the L4 exact-match semantics. If available SQL collation/normalization cannot do so without false negatives, stop and request a design revision; do not weaken the match or silently fall back to a recent-page scan. No schema, index, grant, route, model, embedding, preference persistence, or external resource is authorized by this decision.

## Consequences

- Empty results mean no matching candidate was found in the current-public live set; they never assert that an area or user is safe.
- More than 100 exact matches produce a bounded unavailable outcome rather than an incomplete success.
- Output cardinality is bounded, but query cost and hosted Neon behavior remain unverified. Candidate-reader tests use authored synthetic PGlite rows only.
- The route remains a separate task and must keep preferences transient, require exact server-selected live mode, use one request-scoped SQL operation, and preserve the 100-item contract.
