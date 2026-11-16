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

The database stores append-only, version-bound disclosure decisions and exposes only the latest approved row through a least-privilege view. The public history projector joins every candidate version to its exact reviewed metadata and constructs the existing `HistoryEntry` allowlist. The later exact-live history reader/runtime composes those approved records only when the event remains current-public; withdrawn events and all their history stay hidden. This decision itself does not enable a Worker database binding or hosted deployment. Source rights, current-public checks, and the normal Layer 4 publication gate continue to apply.

## Affected requirements

FR-10/12/13; NFR-01/07.

## Amendment (HOSTED-02, 16 Nov 2026): agent-path review summaries are deterministic templates

- Each published version writes one approved row to `public_event_history_review_decisions` (migration 050 grants the publication writer insert on it). The row's `summary` is a fixed Bahasa Indonesia template, never model output:
  - agent auto-publication: `Diterbitkan otomatis dari {n} sumber`
  - moderator publication: `Diterbitkan oleh moderator`
  - moderator correction: the moderator's own note, trimmed and truncated to 500 characters, or `Dikoreksi oleh moderator` when the note is blank.
- `change_type` is `published` for a new publication and `corrected` for a correction. Withdrawals and no-material-change decisions write no review row.
- The stored event record is the domain schema 2.0 Event with exactly the 23 keys the public readers check. `publication_mode` and waivers stay on the publication decision row and are not copied into the record.
- Known gap: the agent path does not yet persist support evidence references, claim origins or place ids for a published claim. The stored claims therefore carry empty `support` and `origin_ids`, and the event scope carries no place id. The public Layer 4 projection rejects such a version and fails closed until those inputs exist. No geometry is mapped from the model's approximate coordinates, because no source supports them.
