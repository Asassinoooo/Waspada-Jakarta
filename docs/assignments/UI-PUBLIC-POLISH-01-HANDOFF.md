# UI-PUBLIC-POLISH-01 handoff

## Outcome

Added `apps/web/src/public-polish.css` as a final, additive stylesheet for the public web screens. It uses existing palette variables and class names to clarify the feed, detail, evidence, history, preferences, updates, source, and error hierarchies. Lists remain readable, and the header navigation wraps as Beranda, Panduan, and Privasi links are added.

The stylesheet gives controls and footer links 44px minimum targets, preserves visible focus, wraps long user- and source-provided text, and reflows status and preference layouts at narrow widths. It adds no external assets, fonts, dependencies, or animation.

The follow-up fixes align the guide, briefing, and update center on distinct review and source-validity labels; remove user-facing cursor/snapshot jargon; and add `tabIndex={-1}` to assigned main-content targets. Privacy confirmation, cancellation, and outcome updates move focus to the relevant heading/result without representing the inline confirmation as a modal dialog.

## Integration and validation

Import `public-polish.css` after the existing web stylesheets so its overrides are applied. Root integration screenshot review at desktop, 320px, and 200% text size remains necessary; this handoff does not claim those visual checks were performed.

Validation on this branch:

- CSS parsed with the workspace PostCSS parser.
- Focused experience and public-copy tests passed (8 tests).
- `npm run typecheck` passed.
- `npm run build` passed.
- `git diff --check` passed.
- The existing full web suite currently has two stale copy assertions: `test/ui.test.tsx` expects the prior review-freshness label, and `test/updates-center.test.tsx` expects the prior “Cursor” message. The revised user-facing copy is covered by the focused tests; those legacy test files were outside this assignment's allowed paths.

The production build validates the app entry point currently on this branch; it does not import this new stylesheet yet. The explicit PostCSS parse validates the standalone stylesheet. No route, API, dependency, or app entry-point files were changed.

## Review notes

The current [Vercel Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md) informed focus visibility, native control semantics, touch targets, text wrapping, and small-screen layout. Root integration should confirm navigation order, contrast, and rendered layouts in screenshots.
