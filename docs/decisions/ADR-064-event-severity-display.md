# ADR-064 — Three-level event severity shown on the public map

- **Status:** Accepted on 13 November 2026 by owner request under SEV-01.
- **Date:** 2026-11-13
- **Owner:** Team 12
- **Scope:** `apps/intelligence` report interpretation prompt and mock model, the public `EventView` DTO (`apps/worker/src/contracts/public-api.ts`), the in-memory public read model, and the `#peta` map and event list/detail in `apps/web`. No migration, no change to domain schema 2.0, the publication gate or GeoJSON properties.

## Context

The interpretation agent already had a `severity` field (`low|medium|high|critical|unknown`), but the prompt's JSON template never asked for it, so it was almost always `unknown`. It reached the public read model only as a `hazard` tag, and the public map drew every event at the same size. The owner asked for a three-level severity that the map shows as icon size.

## Decision

1. The agent outputs exactly `low`, `medium` or `high`, using a written rubric that names the facts each level needs (deaths, injuries, evacuations, flood depth, riots, closures, transit stoppage, outages). It must use only facts stated in the report, never the category alone, and pick the lower level when unsure. `critical` from a model is normalized to `high`. Anything else becomes `unknown`, which now only means a pipeline fallback or a structured source without a severity field.
2. When reports are merged into one incident, the latest assessed severity wins, so a later report can lower it (for example, a fire that was put out).
3. The public `EventView` gains an optional top-level `severity` (`low|medium|high`). It is omitted when the event was not assessed. Mobile already parses this optional key.
4. On `#peta` the marker icon size scales with severity (core radius 9/12/15, unassessed 10). High adds a pulsing ring, which is static under `prefers-reduced-motion`. Higher severity stacks above lower. A legend explains the scale, and the list card and detail sheet show "Tingkat dampak: Rendah/Sedang/Tinggi" with the note "Perkiraan otomatis dari laporan; bukan jaminan keamanan."
5. Severity is display only. The publication gate (ADR-061) does not read it. It never draws an area or radius, and a low level never means an area is safe.

## Consequences

- Severity is a model estimate, so it can be wrong. The note and the moderator view are the safeguards.
- The hosted DB-backed public path (`publication-writer.ts` `parseEventDraft`, the Worker `EVENT_FIELDS`) does not carry severity yet. The field is optional, so nothing breaks. Local `serve:live` uses the in-memory read model and does show it.
- The demo fixtures have no geometry, so the demo map shows no markers. Demo list and detail show all three levels.
