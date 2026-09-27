# ADR-026: Public update-feed cursor and ordering

- **Status:** Accepted
- **Date:** 27 September 2026
- **Scope:** Exact-live `GET /api/v1/updates` bootstrap, ordering and continuation
- **Owner:** Root planner

## Context

The public update feed reuses per-version moderator-reviewed labels and summaries from the public event-history projection. Its cursor must cover newly disclosed versions without gaps when review transactions overlap. PostgreSQL identity/sequence values and timestamps can be assigned before a transaction commits, so using `review_id` or `reviewed_at` as the global watermark can skip a late-committing row. The existing history view also deliberately excludes any event whose latest version is withdrawn.

## Decision

Add a singleton transactional update-feed counter. A `BEFORE INSERT` trigger on append-only event-history review decisions increments the counter row and stores the assigned `change_sequence` on the new decision. The row lock is held until the decision transaction commits or rolls back; a later writer cannot receive a higher committed sequence first. Counter changes roll back with their decisions. Every decision status advances the counter. Migration 016 adds update-feed-specific watermark and candidate views; the candidate view exposes only the latest approved metadata for exact published versions still present in the current-public history view, plus the sequence and publication time needed by the feed. These update-feed views omit `reviewer_id`. The existing migration-014 history-disclosure view and its internal grant remain unchanged for compatibility with the accepted history reader, which uses reviewer identity only as internal provenance; the Layer 4 serializer omits it from the public `HistoryEntry` response. This feed task does not alter that history-reader contract.

`GET /api/v1/updates` accepts an optional cursor and a bounded page size (default 20, maximum 100). Omitting the cursor bootstraps at the latest committed watermark and returns no earlier changes. A signed cursor continues strictly after its sequence through the watermark observed by that request. Results are ordered by sequence and continue from the last returned sequence when another page is needed; otherwise the cursor advances to the observed watermark. A transaction snapshot keeps the watermark and candidate query consistent. Empty sequence gaps are valid.

The cursor is a versioned base64url HMAC-SHA-256 token with a 30-day expiry. It contains only the dataset scope, feed sequence and expiry metadata. It uses the existing `PUBLIC_EVENT_LIST_CURSOR_HMAC_KEY_HEX` key through a separate domain-separated signature; no new secret or binding is introduced. Expired cursors and valid cursors ahead of the current watermark return HTTP 410 `CURSOR_RESTART_REQUIRED`; malformed, tampered or wrong-scope cursors return the existing bad-request response. Key rotation invalidates outstanding cursors.

Each update item keeps the existing `HistoryEntry` fields. `changed_at` is the exact event version's publication time, while the label and summary must come from its latest approved moderator review. `retracted` can describe a material claim or impact change within an event version that remains publicly published; it never exposes a withdrawn event version. The current-public history view remains the final withdrawal filter: when the latest event version is withdrawn, every version and every update entry for that event stays hidden.

The browser may retain only the opaque cursor locally; it must not persist update-item history. On HTTP 410 it discards the cursor and in-memory update entries, bootstraps a new cursor first, then obtains a fresh current event snapshot before resuming polling. This ordering makes changes after the new watermark pollable; version deduplication handles any overlap with the refreshed snapshot. UI work requests a page size of 20 and fetches each candidate's current public event detail with a fixed concurrency limit to match against browser-local interests. It sends no interest values to automatic polling and never displays an update whose current event detail is unavailable. The UI polls only while the updates view is active, uses manual refresh plus a visible last-check time, and does not imply that missing updates mean an area is safe.

## Consequences and trade-offs

- The transactional counter makes cursor ordering correct under overlapping commits at the cost of serializing the comparatively low-volume moderator history-decision writes on one row.
- The stateless cursor avoids per-user server state and carries no location, interest or event content.
- A first visit establishes a baseline rather than replaying historical updates. A cursor unused for more than 30 days must rebase, so the client explains that older update summaries are unavailable.
- Withdrawal continues to remove all public history. No public tombstone or withdrawal summary is introduced.
- Runtime integration still needs to prove repeatable-read transaction handling with the injected database executor. This ADR changes no provider configuration and enables no live dataset.

## Affected requirements and files

FR-10/11/13; NFR-01/04/05/07; `docs/api/openapi.yaml`; `docs/UX_API_SPEC.md`; `docs/IMPLEMENTATION_BACKLOG.md`; migrations and update-feed reader/runtime/browser assignments.
