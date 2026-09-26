# UI-02-LOCAL-PREFERENCES-CORE — Assignment

**Parent work package:** UI-02 — Preferences, briefing and update centre  
**Status:** Ready for implementation as a bounded local-only foundation  
**Requirement coverage:** US-02; FR-11; NFR-03; NFR-07  
**Dependencies:** UI-00 and UI-API-DETAIL-HISTORY-CORE accepted; SPEC-03 accepted  
**Contract baseline:** Existing `BriefingRequest.interests` in OpenAPI 3.1 (`places`, `services`, `institutions`, `audiences`, `categories`). No contract change is assigned.

## Objective

Add a responsive **Ringkasan saya** screen that lets a visitor inspect, edit, save and clear their interests in this browser. This is the local-preferences foundation of UI-02; it does not claim that a personal briefing or update feed exists yet.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` (first, per repository instructions)
- `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/UX_API_SPEC.md`, especially sections 3 and 5
- `docs/api/openapi.yaml`, `BriefingRequest` and `Category`
- `docs/assignments/UI-00.md` and `docs/assignments/UI-API-DETAIL-HISTORY-CORE.md`
- Current `apps/web/src/App.tsx`, `styles.css`, and web tests

## Assignment and branch rules

- Implementation agent: **gpt-6-luna, max**.
- Branch: `work/UI-02-LOCAL-PREFERENCES-CORE`.
- Use a dedicated worktree; do not edit through the root checkout.
- Root owns the backlog/checkpoint, review, integration, status and push.
- The implementation agent may commit its task branch but must not merge or push.

## Scope and boundaries

1. Add a public navigation route for “Ringkasan saya” and a clear Indonesian preferences form with these existing request dimensions: **Tempat** (`places`), **Layanan** (`services`), **Institusi** (`institutions`), **Kelompok** (`audiences`), and **Kategori** (`categories`). Use the exact ten existing category enum values; localize display labels without inventing category identifiers.
2. Persist preferences only in browser local storage under one versioned, app-specific key. Read, validate, edit, save and clear through a small typed storage boundary that can be tested with an injected/fake storage implementation.
3. Match the existing contract bounds: at most 30 values per string dimension, 128 Unicode characters per value, at most 10 unique categories. Trim strings, ignore empty values and prevent duplicate values after normalization. Do not silently truncate user entries.
4. Make storage-unavailable, malformed-data and write/quota failures visible and recoverable. Do not overwrite unreadable stored content without a deliberate user action. Provide an explicit clear action and report if it fails.
5. State in Bahasa Indonesia that interests stay in this browser and clearing browser data removes them. Make keyboard labels, focus, validation and mobile layout usable.
6. State that the personal briefing/update service is not connected in the current demo. Do not make network requests, infer relevance, render synthetic records as matches, or imply that an empty result indicates safety. Existing event “relevansi” remains “Tidak dinilai”.

Allowed paths: `apps/web/src/App.tsx`, new `Preferences.tsx` and `preferences-store.ts`, `apps/web/src/styles.css`, relevant `apps/web/test/*` files and web test script registration if needed, plus `docs/assignments/UI-02-LOCAL-PREFERENCES-CORE-HANDOFF.md`. Do not edit OpenAPI, Worker/API/domain contracts, dependencies/lockfiles, database, or another task’s files. Ask root about any required scope or contract change; continue other assigned work only if independent.

## Acceptance criteria

- A visitor can navigate to and from the screen; direct loading and refresh of its route render correctly.
- Each displayed field maps exactly to the existing briefing request field. All ten allowed categories are available with understandable Indonesian labels.
- The user can load previously saved values, inspect them, add/remove values, save explicitly, and clear all values. Saved data survives a reload in the same browser.
- Input limits, whitespace normalization, empty entries and duplicates are enforced consistently with the contract and tested.
- Browser storage errors and invalid saved JSON do not crash the page or falsely show “saved”; the user receives a usable explanation and deliberate recovery action.
- No data leaves the browser. No API, fetch, cookie, account, geolocation, notification, matching, or generated update behavior is introduced.
- The interface keeps the global demo warning and explicitly says briefings are not yet connected; it never treats a synthetic or historical event as relevant to a user.
- Tests cover the pure storage/validation behavior and rendered empty, saved, invalid/unavailable, and error states. Review desktop (1440×900) and mobile (390×844) layouts and record the findings.
- No dependency or contract change. Run relevant tests, full workspace tests, typecheck and build from WSL Ubuntu-26.04. Report only checks actually run and their results.

## Verification commands

From `/mnt/d/Projects/RPL` in WSL Ubuntu-26.04 (or the assigned worktree path):

```sh
npm test --workspace=@waspada/web
npm test
npm run typecheck
npm run build
git diff --check
```

Use the repository's existing locked runtime/dependencies. No live sources, paid APIs, external providers, cloud resources or secrets are in scope.

## Handoff and stop conditions

Commit implementation and handoff as coherent, descriptive commits. The final handoff must state branch and worktree, SHA and exact commit messages, changed paths, behavior, checks and results, screenshot dimensions/findings, limitations, migration/configuration impact, and remaining decisions. Stop and report to root if a safe implementation requires changing a contract, adding a dependency, transmitting preferences, or choosing undocumented product semantics.
