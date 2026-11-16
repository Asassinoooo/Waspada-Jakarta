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

## Amendment (HOSTED-10, 16 Nov 2026): one point per published event, from the agent's approximate coordinate or a labelled fallback

Owner decision: points on the map are convenient and loose. The rule is in `apps/worker/src/layers/l4-application-integration/public-point.ts`.

- **One Point per event.** Every published event gets exactly one Point geometry, except a `group_specific_critical_notices` event with no location. That notice is listed, with no point.
- **Order.** A source coordinate comes first when a source gives one (none does today). Otherwise the agent's `approximateCoordinates`, stored as geometry source `model_approximate`, is used when it is finite and inside the sanity box (lat -6.4 to -5.0, lon 106.6 to 107.1). The box is a plausibility check, not a boundary. Otherwise the point is the Jakarta centre (lat -6.2, lon 106.82), stored as `fallback_jakarta_centre` and labelled `Perkiraan pusat Jakarta, lokasi belum diketahui`, so it is never shown as a source location.
- **Shape.** A Point only, with role `approximate_place`, `precision_m` null and `precision_basis` unknown. No radius, polygon or line is ever written. The geometry row has no source column, so the source is recorded on the publication decision as `geometry_source` and `geometry_status`.
- **Place optional.** The proposal engine no longer invents a point for Jakarta-scoped sources. An event needs a place id or a location label, except a group notice. The read model refuses a non-group event with neither (`INVALID_EVENT`, publication denied). The projector counts a geometry as a public target, so a point alone is enough. It cannot see the label, because the stored record has no slot for it.
- **Evidence.** A publication fills each claim's `support` from the persisted evidence of the proposal's own grounding context, only when the proposal came from one report revision. A point needs persisted evidence to be written. If it cannot be written, the publication is refused. Nothing is written in that case.
- **Still hidden on the DB path.** No origin writer exists, so `origin_ids` stay empty and the strict projector still rejects these events as `INVALID_EVENT`. The list skips them and the page does not fail. Public attribution also needs an approved `public_attribution_review_decisions` row, which no writer creates. Both remain gated.
- **Unchanged.** The ADR-061 automatic gate still reports `location_missing` for an event with no label and no coordinate, so a location-less group notice waits for a moderator. The moderator publish path has no location check, so it lists the notice. The reject and moderation rules are unchanged.

This amendment supersedes the sentence in the HOSTED-02 known-gap note that says no geometry is mapped from the model's approximate coordinates.
