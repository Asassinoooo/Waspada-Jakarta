# UI-PUBLIC-POLISH-01 handoff

**Record scope:** Task-branch checks at its recorded revision. Root subsequently tested populated synthetic API details, corrected narrow/large-text wrapping and checked navigation focus; see the [integration handoff](UX-DESIGN-FLUTTER-01-HANDOFF.md) for those later results.

## Outcome

Added `apps/web/src/public-polish.css` as a final, additive stylesheet for the public web screens. It uses existing palette variables and class names to clarify the feed, detail, evidence, history, preferences, updates, source, and error hierarchies. Lists remain readable, and the header navigation wraps as Beranda, Panduan, and Privasi links are added.

The stylesheet gives controls and footer links 44px minimum targets, preserves visible focus, wraps long user- and source-provided text, and reflows status and preference layouts at narrow widths. It adds no external assets, fonts, dependencies, or animation.

The follow-up fixes align the guide, briefing, and update center on distinct review and source-validity labels; remove user-facing cursor/snapshot jargon; and add `tabIndex={-1}` to assigned main-content targets. Privacy confirmation, cancellation, and outcome updates move focus to the relevant heading/result without representing the inline confirmation as a modal dialog.

## Integration and validation

Import `public-polish.css` after the existing web stylesheets so its overrides are applied. The narrow and large-text route checks are recorded below; desktop screenshot review remains part of root integration.

The narrow-screen follow-up reproduces the source of the large-text overflow: at a 320px viewport and a 32px root font, the discovery grid's inherited `15rem` minimum expands to 480px, and the evidence metadata's two-column layout collapses its second track. Before the fix, document `scrollWidth` measured 500px on the feed and 361px on evidence review. The mobile rules now set the discovery track to `minmax(0, 1fr)`, stack evidence metadata, wrap long source labels, and constrain the focused skip link to the viewport.

I checked the integrated root `?qa=reflow` page in headless Chrome after injecting this stylesheet. At 320px with `html { font-size: 32px }`, document and body `scrollWidth` were 320px on Jelajah list/map, Preferences, Updates, Guide, Privacy, evidence review, API detail, and presentation detail. Main content measured 280px wide with no internal horizontal overflow on those routes. The standard 16px root-font check also measured 320px document/body width across the feed, preferences, updates, guide, privacy, evidence, and API detail routes. A focus-state pass across 150 visible links and controls in the list/map and public screens found no target outside the viewport; the search input receives its visible ring from the surrounding control.

The test page's API context was unavailable: the API detail stayed in its loading state, and the presentation route showed its unavailable fallback. Those checks cover the shell and fallback layouts, not a populated API detail record. The landing route was outside this stylesheet follow-up.

Validation on this branch:

- CSS parsed with the workspace PostCSS parser.
- Focused experience and public-copy tests passed (8 tests).
- `npm run typecheck` passed.
- `npm run build` passed.
- `git diff --check` passed.
- The existing full web suite currently has two stale copy assertions: `test/ui.test.tsx` expects the prior review-freshness label, and `test/updates-center.test.tsx` expects the prior “Cursor” message. The revised user-facing copy is covered by the focused tests; those legacy test files were outside this assignment's allowed paths.

The production build validates the app entry point currently on this branch; it does not import this new stylesheet yet. The headless route check injected the updated stylesheet directly into the integrated root QA page, and the explicit PostCSS parse validates the standalone stylesheet. No route, API, dependency, or app entry-point files were changed.

## Review notes

The current [Vercel Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md) informed focus visibility, native control semantics, touch targets, text wrapping, and small-screen layout. Root integration should confirm navigation order, contrast, and rendered layouts in screenshots.
