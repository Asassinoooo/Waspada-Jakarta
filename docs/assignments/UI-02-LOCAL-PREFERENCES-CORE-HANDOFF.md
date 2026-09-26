# UI-02-LOCAL-PREFERENCES-CORE — Handoff

## Delivery

- Branch: `work/UI-02-LOCAL-PREFERENCES-CORE`
- Worktree: `C:\Users\perry\.codex\worktrees\ui-02-pref-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/ui-02-pref-core/RPL` in WSL)
- Implementation commit: `be4c34dd762fcb6b0f757b7e0ceb0204881c4934` — `feat(UI-02-LOCAL-PREFERENCES-CORE): add browser-local preferences`
- Implementation paths: `apps/web/package.json`, `apps/web/src/App.tsx`, `apps/web/src/Preferences.tsx`, `apps/web/src/preferences-store.ts`, `apps/web/src/styles.css`, `apps/web/test/preferences.test.tsx`

## Behavior

Added the public `#ringkasan-saya` route with Indonesian editors for places, services, institutions, audiences, and all ten contract categories. Values are trimmed, NFC-normalized, deduplicated, and validated against the contract's per-field limits. Users explicitly save or clear the versioned `waspada-jakarta:preferences:v1` browser-local entry. Malformed saved data is preserved until deliberate clearing; storage read, write, and clear failures show recoverable feedback.

The screen says preferences stay in this browser, browser-data clearing removes them, and briefing/update matching is not connected. It makes no network request and does not treat synthetic records as relevant or imply safety. Entering the preferences route skips the app's existing API-read effect.

## Verification

Ran in WSL Ubuntu-26.04 with Node `v24.21.0` and npm `11.19.0`:

- `npm test --workspace=@waspada/web` — passed, 20 tests.
- `npm test` — passed, 241 tests total: web 20, Worker 131, DB 78, casebook 12.
- `npm run typecheck` — passed.
- `npm run build` — completed successfully; Vite build and Wrangler dry-run finished (`--dry-run: exiting now.`).
- `git diff --check` — passed.

Headless Chrome visual review used exact device metrics and no desktop interaction. At 1440×900 the page layout looked good, with content continuing below the viewport as expected. At 390×844 the navigation chip and demo banner fit, and privacy/briefing text wraps within the cards. Measured at 390×844: `innerWidth`, document client/scroll width, and body client/scroll width were all 390; the primary nav occupied x=10..380 with client and scroll widths of 370; no element overflowed the viewport. A supplemental 320×844 check also reported document/body width 320 and no overflowing elements. Captures: `C:\Users\perry\AppData\Local\Temp\ui02-preferences-desktop-final.png` and `C:\Users\perry\AppData\Local\Temp\ui02-preferences-mobile-final.png`.

## Impact and remaining decisions

No contract, dependency, lockfile, server, database, or configuration change. The feature is local-only; the briefing/update service remains disconnected. There are no remaining implementation decisions or blockers; root review and integration remain pending.

The temporary `node_modules` symlink used for WSL checks was removed before commit and is absent from the worktree.
