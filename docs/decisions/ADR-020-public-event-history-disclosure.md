# ADR-020 — Public event-history disclosure

- **Status:** Accepted for implementation
- **Date:** 26 September 2026
- **Owners:** Team 12

## Context

The public `HistoryEntry` contract requires a `change_type`, `changed_at`, and a concise `summary`. Stored event versions establish their exact identity and publication time, but their content alone does not establish whether a change should be described as a correction, impact change, or retraction. Model-generated labels and summaries could misstate the record. The accepted API-PUBLIC-HISTORY-READER-CORE returns only untrusted internal version records and deliberately does not create these public claims.

## Decision

- Every public history entry must have a moderator-reviewed disclosure record bound to its exact `(dataset_kind, event_id, event_version)`.
- The moderator explicitly selects a `change_type` already allowed by the public contract and writes the public summary. Neither value is inferred by an LLM, computed from a text diff, or copied from an unreviewed event summary.
- `changed_at` is the exact version's stored `published_at`; the separate review timestamp records when the disclosure metadata was reviewed. These times must not be conflated.
- Only approved disclosure metadata for published versions of a currently public live event may be projected. A missing, revoked, stale, or mismatched review cannot be treated as approval. The future Layer 4 projector must not silently return a partial history page when a candidate version lacks its required reviewed metadata; it must fail closed or report history as unavailable.
- Withdrawn versions are not public history entries. If the latest event version is withdrawn, the event and its entire history remain absent from the public views. Retraction details are not exposed.
- Moderator authentication, authorization, review writes, and audit of real decisions belong to MOD-01. Until those controls exist, tests may use authored fictional review rows only. The public DTO remains unchanged unless a later decision explicitly revises it.

## Consequences

A future database foundation may store append-only, version-bound disclosure decisions and expose only the latest approved row through a least-privilege view. The public history projector must join every candidate version to its exact reviewed metadata and construct the existing `HistoryEntry` allowlist. No public history route or Worker database binding is enabled by this decision. Source rights, current-public checks, and the normal Layer 4 publication gate continue to apply.

## Affected requirements

FR-10/12/13; NFR-01/07.
