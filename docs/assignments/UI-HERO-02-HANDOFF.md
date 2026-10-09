# UI-HERO-02 — Jakarta illustration and bounded entrance

**Status:** Historical task-branch handoff, integrated by root on 9 October 2026. The [integration handoff](UX-DESIGN-FLUTTER-01-HANDOFF.md) records mounted-app acceptance and supersedes the integration instructions below.

**Branch:** `work/UI-HERO-02` · **Base:** `28ea61db4f83532570dea9edabceb74be89b10d4` · **Implementation:** `c40529114c414f44a356be549618f6b915dc4eac`.

The user's scoped illustration/animation authorization applies to this Sol/max slice. Implementation changes only `apps/web/src/HeroIllustration.tsx` and artwork selectors/keyframes in `apps/web/src/landing.css`. Landing, public data, routes, dependencies and global styles are unchanged.

## Result

The original civic illustration now has an asymmetric skyline with architectural seams, a clearer Monas shaft/flame/stepped base, a broad river with separate banks and water strokes, and a flyover with visible supports. Three small folded-paper motifs refer to Laporan, Bukti and Konteks. The former dot and page-like counter are removed. Topic labels sit in a normal-flow footer, where they can wrap without crossing the river.

Artwork uses existing palette variables; yellow is confined to the Monas flame. It contains no event geometry, danger areas, incident markers, live counters, verification marks, gradients or filters. No fonts, external assets, packages or animation runtime are added. The SVG remains `aria-hidden="true"` and `focusable="false"`; the visible caption remains **“Ilustrasi Jakarta — bukan peta kejadian.”** Intrinsic SVG dimensions and an aspect ratio reserve the scene. A 620 CSS-pixel maximum keeps SVG scaling from magnifying movement beyond the limit.

The complete scene is the base state. Entrance rules apply only under `prefers-reduced-motion: no-preference`; reduced motion explicitly removes every artwork animation. The river mask uses transform/opacity instead of a stroke-dash animation. Unsupported animation leaves the complete base; removing the mask leaves the complete river. Stable classes and IDs introduce no polling, scroll or interaction trigger.

| Layer | Start | Duration | Finish | Maximum SVG travel |
| --- | ---: | ---: | ---: | ---: |
| River mask | 0 ms | 350 ms | 350 ms | 6 px |
| Skyline | 180 ms | 640 ms | 820 ms | 8 px |
| Monas | 260 ms | 640 ms | 900 ms | 8 px |
| Flyover | 340 ms | 620 ms | 960 ms | 8 px |
| Laporan paper | 620 ms | 320 ms | 940 ms | 6.71 px |
| Bukti paper | 700 ms | 320 ms | 1020 ms | 6.71 px |
| Konteks paper | 780 ms | 320 ms | 1100 ms | 6.71 px |

Each animation has one iteration, uses only transform/opacity, and ends still. Maximum measured desktop displacement was 7.974 CSS px; paper displacement was 6.687 CSS px. No moving layer is nested inside another moving layer.

## Actual checks

WSL Ubuntu-26.04, Node `v24.21.0` from `/home/perry/.local/opt/waspada-node-v24.21.0/bin`, npm `11.19.0`, existing dependency symlink:

- `node_modules/.bin/tsx --test apps/web/test/landing.test.tsx`: **9/9 passed**.
- `npm run typecheck --workspace=@waspada/web`: passed.
- `npm run build --workspace=@waspada/web`: passed before and after the change, including the final footer/cap refinement.
- Paired SSR hero probe: two distinct mask IDs, both references resolve to their own mask.
- `git diff --check`: passed with Windows Git. WSL Git could not resolve this Windows-created worktree's absolute metadata pointer; no metadata was changed.

Local visual checks used only Playwright with **headless Chrome 155.0.8059.39**, a separate temporary profile and a standalone SSR landing HTML with the worktree's CSS. Root's server and checkout were not used:

- 1440, 768, 390 and 320 px: art/caption visible, no artwork overflow; reduced motion returned zero animations.
- Motion frames 0, 550 and 1100 ms inspected. Browser timings confirmed seven single-iteration animations and a maximum 1100 ms finish.
- Browse anchor focused and clicked at frame 0; opacity 1, pointer events available, destination `#jelajah`.
- Forced `animation: none`: all seven animated layers had opacity 1 and transform none. Mask removal also preserved the complete scene.
- 320 px with a 32 px root font and root's already-planned shell/min-width fixes injected into the temporary preview: art, topic labels and caption stayed within their containers. This is a scoped preview check, not an integrated app result.

Temporary screenshots: `C:/Users/perry/AppData/Local/Temp/ui-hero-02-{1440,768,390,320}.png`, `ui-hero-02-motion-{0,550,1100}.png`, `ui-hero-02-no-mask.png`, and `ui-hero-02-320-text-2x.png`. These are local review evidence, not repository assets.

## Compressed budget

Both production builds used the same worktree, dependencies, Node and build command. Exact bytes below use Node `gzipSync` with its default options. Hero budget input is SSR figure markup + one newline + the **entire** landing CSS source, so it includes more than the art CSS.

| Measurement | Base `28ea61d` | Final implementation | Delta |
| --- | ---: | ---: | ---: |
| SSR figure, raw | 2899 B | 5466 B | +2567 B |
| Landing CSS source, raw | 11330 B | 12024 B | +694 B |
| Figure + landing CSS, gzip | 3633 B | **4326 B (4.22 KiB)** | +693 B |
| Production JS, gzip | 98464 B | 99234 B | +770 B |
| Production CSS, gzip | 9648 B | 9746 B | +98 B |
| Production JS + CSS, gzip | 108112 B | 108980 B | **+868 B** |

Final assets: `index-DXckhwCq.js` (351242 B raw) and `index-DUxMxkli.css` (52197 B raw). The hero budget is below 20 KiB; dependency and runtime additions are zero. This is a local transfer-size comparison, not a device-performance claim.

## Root integration

Cherry-pick the implementation and this separate handoff commit. Root's non-art landing CSS fixes belong to different selectors. Root still owns the full app/browser integration check, including React rerenders, context failure, production layout stability and the full test suite. Physical Android/TalkBack, low-end mask repaint performance, human usability and hosted behavior were not exercised in this slice. No push or deployment was performed.
