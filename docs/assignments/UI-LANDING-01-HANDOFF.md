# UI-LANDING-01 handoff

Implementation is committed on `work/UI-LANDING-01` in commit `ad8ccad` (`feat(UI-LANDING-01): add account-free Jakarta landing`). The branch started from `9851632df57010579eaab56ff9dffeff7414dda8`.

## Delivered

- Added `Landing`, accepting `context: PublicContext | null`, read-only `events`, `status` (`loading`, `loaded`, or `unavailable`), and optional `onRetry`.
- Added a responsive Bahasa Indonesia landing with an account-free public-browse action, optional interest-settings action, reading guide, report preview, privacy link, and explicit trust/error/empty states.
- Report previews are suppressed when dataset context is unknown and while data is loading or unavailable. Demo labels follow the provided dataset mode/label. Each preview keeps lifecycle, freshness, evidence, source, and event time distinct. No map geometry or verification claim is introduced.
- Added the decorative Jakarta SVG hero with a bounded river-mask reveal and skyline/flyover settle, plus a static reduced-motion treatment. The caption clarifies that it is not an incident map.
- Added six server-rendered component tests covering account-free navigation, unknown-context suppression, demo labeling, live report fields, loading/error/empty states, and guide semantics.

## Integration

Keep `SiteHeader` and its persistent mode selector under the app shell. On the landing route, render `Landing` as the page's single `<main>` element; it already owns `id="main-content"`, so do not wrap it in another main or duplicate that ID. Pass the loaded public context and current report page, map request states to `status`, and make `onRetry` refresh both context and reports. Import `apps/web/src/landing.css` from the app entry point; CSS is intentionally not imported by `Landing.tsx` so the Node SSR test can load the component directly.

The component links to `#jelajah`, `#ringkasan-saya`, `#panduan`, and `#privasi`; preserve those route/section targets in the app shell. Landing is not wired into the current app entry point in this assignment.

## Validation

Run from the worktree through WSL Ubuntu 26.04 with Node `v24.21.0` and npm `10.9.0`:

- `npx tsx --test apps/web/test/landing.test.tsx` — 6 passed, 0 failed.
- `npm run typecheck --workspace=@waspada/web` — passed.
- `npm run build --workspace=@waspada/web` — passed. This build is the current app build; `Landing` and `landing.css` are not imported until integration, so it does not validate the integrated landing bundle.
- `./node_modules/.bin/esbuild apps/web/src/landing.css --outfile=/tmp/ui-landing.css` — CSS parsed successfully.
- `git diff --check` and `git diff --cached --check` — passed before the implementation commit.

No browser or headless-browser visual review was available in the worktree; no visual result is claimed. The untracked `node_modules` symlink is local setup and is not part of either commit.
