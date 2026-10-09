# UI-EXPERIENCE-01 handoff

**Branch:** `work/UI-EXPERIENCE-01`

**Base:** `9851632df57010579eaab56ff9dffeff7414dda8`

**Implementation commit:** `f6f82f3` (`feat(UI-EXPERIENCE-01): add optional guide and privacy controls`)

This slice adds a standalone optional reading guide, a local privacy page, an explicit two-step reset, and focused tests. It leaves routing and global stylesheet imports to root integration.

`ReadGuide` explains event/impact lifecycle, freshness versus issuer validity, evidence, relevance, separate event/observation/publication/fetch/validity times, and evidence-backed map geometry. It is ordinary page content with direct links to discovery; it adds no tour state or permission request.

`PrivacyPage` lists the presence of the two current application-owned browser keys without exposing their values. It explains local interests and the opaque update cursor, explicit live-only briefing submission, local matching during update polling, ordinary network metadata, and the limits of browser-side deletion. The reset imports both existing key constants, removes only those keys, reads each key back to verify its resulting state, and reports absent/present/unavailable per key. It never clears unrelated storage or claims to erase source or provider records. `onCleared` runs after any deletion attempt so the integrated app can invalidate in-memory views after a partial outcome as well as a complete one.

The new `experience.css` supplies page-scoped layout, visible focus, 44 px controls, narrow-width stacking, and a reduced-motion-safe static presentation. No global stylesheet or component route was changed.

## Checks run

- Focused WSL test: `node --import tsx --test test/experience.test.tsx` — 5 tests passed, covering verified reset, partial failure, inaccessible storage, unrelated-key preservation, and server-rendered guide/privacy content.
- WSL web typecheck: `npm run typecheck` — passed.
- WSL web production build: `npm run build` — passed.
- `git diff --cached --check` — passed before the implementation commit.

## Integration limits

This branch does not add App routes, navigation links, or the root import for `experience.css`; those are shared integration paths. Tests render the pages to static markup and exercise the storage operations with injected storage. They do not simulate browser button clicks, keyboard focus, localStorage security behavior in a real browser, or assistive technology. Root integration should verify the two-stage interaction and `onCleared` behavior in the mounted app and include the assigned responsive/accessibility visual review.
