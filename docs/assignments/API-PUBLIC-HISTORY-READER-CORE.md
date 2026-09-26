# API-PUBLIC-HISTORY-READER-CORE — bounded published-version reader

- **Backlog ID:** `API-PUBLIC-HISTORY-READER-CORE`
- **Objective:** Provide a least-privilege internal reader for published versions of a currently public live event, preserving exact version identity and returning bounded schema 2.0 records for a later L4 history projection.
- **Dependencies:** `DATA-01`, `DB-TEST-RUNNER-ISOLATION`, `API-PUBLIC-SNAPSHOT-CORE`, `API-PUBLIC-DETAIL-PROJECTION-CORE`, `ADR-012`.
- **Requirements:** `FR-10/13`, `NFR-01/07`.
- **Allowed paths:** `apps/db/migrations/013_public_event_history_reader.sql`; `apps/db/src/public-event-history.ts`; `apps/db/test/public-event-history.test.ts`; `apps/db/test/migrations.test.ts` (migration-sequence expectations only); and this assignment's implementation handoff only.
- **Forbidden scope:** No HTTP route, public HistoryEntry projection or summary, OpenAPI/public DTO change, Worker/runtime binding, migration runner change, publication/moderation behavior, source acquisition, live-source assumption, retraction-visibility policy, paid service, dependency, or unrelated path.
- **Branch/worktree:** Use a dedicated branch `work/API-PUBLIC-HISTORY-READER-CORE` in the prepared task worktree. Start from the root's pushed assignment commit; do not edit through the root checkout.
- **Contract versions:** Internal source records remain schema 2.0; public history contracts remain unchanged. The repository output is untrusted internal input and must never be serialized directly to a client.
- **Dependencies/configuration:** No new package or runtime configuration. Use the existing SQL executor, migration harness and authored PGlite tests.

## Context to read before editing

Read `SOFTWARE_DEVELOPMENT_PLAN.md`, this assignment and its backlog row, then inspect `docs/decisions/ADR-012-public-projection-boundary.md`, `docs/DOMAIN_MODEL.md`, `docs/UX_API_SPEC.md`, `docs/api/openapi.yaml`, `apps/db/migrations/001_foundation.sql`, the current `public_event_versions` view, `apps/db/src/public-event-snapshot.ts`, the existing geometry and lookup repositories, and DB test conventions. Confirm what makes an event currently public and how append-only versions are represented before designing the view.

## Required behavior

1. Add a security-barrier view exposing only published versions for a `live` event that still has a current published version in the existing safe public view. A latest withdrawn event must not expose a history through this view. Historical and synthetic datasets, unpublished records and withdrawn versions are excluded.
2. Grant `waspada_public_reader` SELECT only on the filtered view. It must retain no direct access to `event_versions` or other publication/private tables. Preserve exact stored `record_json` only as internal L4 input.
3. Add an injected parameterized reader addressed by one validated exact event ID. Bound page size and query `limit + 1` (or equivalent) to detect continuation without silent truncation. Use stable keyset order by version, validate event/version identity and closed schema envelope, and return a safe `missing` result when the current event is not public.
4. A continuation boundary must be a validated version value; it cannot skip across event IDs, datasets or current public versions. Results are deterministic and fail closed on malformed, duplicate, unexpected or identity-mismatched rows with stable redacted errors.
5. Do not derive or claim public change types, correction summaries, retraction messages or freshness meaning. This is a storage/read foundation; L4 must later create the unchanged public `HistoryEntry` allowlist.
6. Use only authored fictional PGlite records. A `live` marker in a test is not real publication, permission, source evidence or factual quality.

## Acceptance criteria

- Only published versions belonging to a currently public live event are visible through the history view; latest-withdrawn, historical, synthetic, unpublished, malformed and unrelated rows are inaccessible.
- The reader is exact-ID, parameterized, bounded, deterministic, version-keyset based, identity-validating and redacted.
- The public-reader role can SELECT the new filtered view but cannot read base event/publication tables or private sources.
- Tests cover multiple published versions, stable order, page continuation/overflow, missing/currently withdrawn events, non-live datasets, malformed identities, query parameters, and least-privilege grants.
- No public summary, change-type inference, retraction policy, HTTP route, runtime binding, source, contract or dependency is added.

## Verification (WSL Ubuntu-26.04 only)

Record `node --version`, `npm --version`, `git --version` and relevant package versions. Use existing dependencies. Run the focused test, `npm run db:test`, full `npm test`, `npm run typecheck`, `npm run build` and `git diff --check`. Report each actual result; do not describe hosted Neon behavior as verified.

## Commit and handoff

Implement only on the assigned branch/worktree. Commit implementation and this assignment's handoff in coherent, descriptive commits. Leave the checkout clean. Do not merge or push. Report exact branch/worktree, SHA(s), commit messages, changed paths, behavior, actual checks/results, limitations, configuration impact and remaining decisions. Root independently reviews and integrates.

## Stop conditions

Stop and report if safe history visibility requires exposing withdrawn events, changing the public history DTO, inventing a public correction/retraction summary, changing source-rights policy or wiring a live runtime. Continue unrelated safe work within scope where possible. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append the exact branch/worktree, commit(s), changed paths, behavior, actual WSL checks, limitations and remaining decisions here. Do not merge or push.
