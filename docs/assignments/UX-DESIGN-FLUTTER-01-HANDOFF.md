# UX-DESIGN-FLUTTER-01 — integrated local experience

**Date:** 9 October 2026 · Team 12  
**Integration branch:** `codex/ux-design-flutter`  
**Status:** Accepted for the bounded local implementation after root review.  
**Scope:** Account-free public web experience and Flutter/Dart Android reader. This record supersedes pending integration statements in the individual task-branch handoffs; it does not establish hosted or native-release readiness.

## Delivered behavior

- `#beranda` introduces the service, links directly to discovery and optional interests, and previews only records permitted by the confirmed dataset context. Preview evidence and source labels refer to the displayed claim. Unknown context, loading, empty and unavailable states do not imply safety.
- Original Jakarta SVG artwork has a skyline, Monas, river, flyover and paper planes. One entrance finishes within 1.1 seconds; movement stays within 8 CSS pixels. Reduced motion and disabled animation preserve the complete static illustration. It is explicitly decorative, never event geometry.
- `#panduan` explains lifecycle, freshness, evidence and relevance separately, with event/observation, publication, source-fetch and validity meanings. It is optional and directly reopenable.
- `#privasi` explains local interests and the update cursor. A confirmed reset removes only the two owned browser keys, verifies each removal, reports partial failures, invalidates related memory and preserves unrelated storage and browsing filters. Confirmation, cancellation and result focus are checked.
- Static screen polish covers discovery, details/evidence/history, preferences, updates and read-only review. New route navigation starts at the title/main focus; refreshes and skip links preserve reading position. Narrow layout wraps long titles, scope labels and source content rather than hiding overflow.
- `apps/mobile` is a separate Layer 4 Flutter client: context-gated landing, bounded list/filter/paging, detail/evidence/reviewed history, guide and optional local interests/privacy. Only the existing context/list/detail/history GET endpoints are used. Interest matching is local, field-specific and normalized; responses and requested IDs are validated. Stale requests cannot replace newer state.
- Flutter saves and clears preferences serially, verifies deletion, rejects stale retry reads after edits, and deduplicates NFC-equivalent values. Android backup is disabled with explicit preference-file exclusions. The client has no account, location request, maps, notification subscription, background monitoring or persisted incident responses.

Existing public DTOs, Worker behavior, publication/withdrawal/history rules and the five-layer AI boundaries remain unchanged. No live source, hosted service or model provider was activated. Flutter requires an explicit API origin; it does not invent a production endpoint.

## Agent branches and integration

| Package | Agent/model | Task branch | Root implementation/handoff commits |
| --- | --- | --- | --- |
| UI-LANDING-01 | GPT-6 Luna/max | `work/UI-LANDING-01` | `832e41a`, `cc06153`; evidence/expiry refinements `9cdd168`, `28ea61d` |
| UI-EXPERIENCE-01 | GPT-6 Luna/max | `work/UI-EXPERIENCE-01` | `92f7101`, `0010a25`; plain-copy refinement `674c99f` |
| UI-PUBLIC-POLISH-01 | GPT-6 Luna/max | `work/UI-PUBLIC-POLISH-01` | `8c32995`, `32b8c64`, `c3b74ac`; root reflow corrections `435268f`, `21aabf2` |
| UI-HERO-02 | GPT-6.1 Sol/max, complex SVG/motion only | `work/UI-HERO-02` | `52be807`, `d1fa82b` (original agent commits `c405291`, `37f2b31`) |
| MOBILE-FLUTTER-01 | GPT-6 Luna/max | `work/MOBILE-FLUTTER-01` | `77ad690`, `d5dfeab`; preferences `dbbae86`, `b447f0b`; Bahasa/copy `48036c9`, `1556beb` (original `33e67dd`, `0402c8f`, `126b55b`, `53cefd1`, `840ab6e`, `024be4e`) |
| Root integration | Planner/reviewer | `codex/ux-design-flutter` | Routing/cache/bootstrap `65154b8`; regression/layout `3cdfebd`; current decisions `d30b436`; navigation follow-up `28e9aa8` |

Independent Luna reviewers checked documentation consistency and the mobile source. All three mobile preferences findings were addressed: stale retry replacement, NFC duplicate detection and storage jargon. Final native back labels and clear-data copy were corrected, tested and inspected through browser semantics. Root verified the integrated mobile source and handoff are identical to the final task branch. Branch history is the authoritative list of every commit; slice handoffs retain their original task-time evidence.

## Actual verification

Runtime/test/build commands use WSL **Ubuntu-26.04**, native Node **24.21.0** and npm **11.19.0**. Browser inspection uses separate **headless Chrome** with Playwright on Windows against WSL services; it does not control the user's desktop or an Android device.

| Check | Actual result |
| --- | --- |
| Integrated web suite | `npm run test --workspace=@waspada/web`: **80/80**, repeated after the navigation correction |
| Full project typecheck/build | `npm run build`: passed web/Worker/DB/evaluation typechecks, Vite production build and Wrangler **dry-run**, no deployment |
| WSL local UI/API smoke | Passed context/list/detail/history, returned timestamps, demo labels and honest empty evidence/geometry |
| Mounted web browser sweep | 16 desktop/mobile/large-text cases passed; widths 1440/390/320, with 200% root text at 320 on landing/feed/guide/privacy/preferences and populated synthetic/presentation detail; one main, no horizontal document overflow or clipped landing headline; no runtime errors |
| Browser behavior | Reduced-motion SVG static; context HTTP 503 hides previews; exact local deletion preserves unrelated data and filters; confirmation/cancel/result and keyboard skip focus pass; no automatic interest POST; list-to-detail navigation starts at scroll 0 and focuses main |
| Flutter source checks | Agent analyze clean and **24/24** injected API/preferences/race/widget tests, including 320 logical px and 2× text. Root independently passed `flutter pub get --offline`, `flutter analyze --no-pub` and `flutter test --no-pub --reporter expanded`: **24/24** on the integrated source |
| Flutter web preview | Debug build with local-only resources and scoped localhost origin; headless browser confirmed context/list/detail/history GET roundtrip and inspected landing/list/detail/preferences/guide at 390/320, including final Bahasa back semantics; no runtime errors or automatic POST observed |
| Android | Final debug APK compiled in 59.3 seconds with API 36 and the Flutter-pinned NDK; artifact size/hash and package metadata checked. No native device run |

The full backend/DB test suite was not rerun for this client-only wave. Its typechecks/build did run; neither client acceptance nor authored fixtures establish live factual quality.

## Visual review and corrections

Desktop art and typography provide a distinctive Jakarta entry point, while the feed stays a readable list. On mobile, browse and optional-interest actions remain immediately usable and the skyline sits below them. Operational views use labels, dividers and evidence/time hierarchy instead of decorative motion.

Review caught a narrow hero grid/headline constraint, oversized operational layout, and long populated-detail headings/scope labels at enlarged text. These now wrap without clipping. Mounted privacy checks confirmed deletion/focus behavior beyond the initial server-rendered component tests. A retained list scroll position on opening details was corrected to start the new screen at its heading.

Ignored screenshots and review scripts are under `.codex-build/`; they are local inspection artifacts, not source-controlled screenshots or proof of a native accessibility audit.

### Web size comparison

Vite-reported decimal kB, same project build mode:

| Output | Before wave | Final | Gzip change |
| --- | ---: | ---: | ---: |
| CSS | 30.69 / gzip 6.18 | 53.17 / gzip 9.92 | +3.74 kB |
| JS | 321.51 / gzip 92.70 | 352.11 / gzip 100.42 | +7.72 kB |

Combined gzip increase is **11.46 kB**. The complex hero refinement alone added **868 bytes gzip** against its assigned base; complete hero markup plus landing CSS measured **4.22 KiB gzip**. No web runtime dependency, external font or asset was added. Flutter dependencies are isolated in its own locked package; pinned `unorm_dart` supplies backend-compatible NFC normalization.

## Setup, artifacts and remaining gates

See [web bootstrap](../BOOTSTRAP.md) and [Flutter setup/parity matrix](../../apps/mobile/README.md). Local review used web port **55173**, Worker **58787** and Flutter preview **55000** to avoid occupied ports. WSL file polling and API proxy overrides are optional local-development settings.

Flutter/Android compilation temporarily pressured WSL memory during a cold toolchain build. Task-owned idle build daemons were stopped; the project caps Gradle heap at 2 GiB, metaspace at 1 GiB, Kotlin heap at 1 GiB and workers at two, with parallel execution off. The final APK compiled after those bounds. This does not establish behavior on low-memory phones.

Final local APK: `.codex-build/artifacts/Waspada-Jakarta-debug.apk`, copied from the clean task branch's final `apps/mobile/build/app/outputs/flutter-apk/app-debug.apk`; **168,928,309 bytes** (about 161.10 MiB). Root independently verified SHA-256:

```text
27bcdb72e6d3d3219a851f643ba1446b99b6cae721b079a0509f679849cbd3fc
```

`aapt` inspection identifies `id.waspada.waspada_jakarta_mobile`, label **Waspada Jakarta**, and compile/target API **36**. The app requests `INTERNET`; merged AndroidX metadata adds only an app-scoped signature permission for non-exported dynamic receivers. It does not request location or notification permission.

This debug validation APK was built **without `API_ORIGIN`**: it deliberately opens the configuration-unavailable state until rebuilt with a configured endpoint. For local emulator use, follow the README's explicit debug-only loopback defines; for production use, supply an absolute HTTPS origin. The browser preview's localhost configuration is not a hosted service and is not embedded in this APK. APK size reflects a debug, multi-architecture validation build; release size has not been measured.

Build outputs, SDK caches, signing/local configuration and screenshots remain ignored and are not pushed.

Open gates: real Android/emulator installation, TalkBack/manual screen-reader and human usability checks; approved live source rights, labelled evaluation data and a production API origin; hosted Cloudflare/Neon Free behavior and recovery; signed Android distribution/release ownership. PWA/offline caching, push, Flutter maps, briefings/update polling and background work remain separately deferred. Browsing remains account-free throughout.
