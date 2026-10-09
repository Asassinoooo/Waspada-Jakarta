# MOBILE-FLUTTER-01 handoff

Implementation commits: `33e67dd` (`feat(mobile): add Flutter public reader`) and `126b55b` (`fix(mobile): protect local interest edits`).

The new `apps/mobile` Flutter client provides an account-free Jakarta landing page, bounded public event list with documented filters and manual paging, detail/evidence/history, a local reading guide, and optional device-only interests. It waits for the API context before showing records, labels demo data, separates event/observation, publication, context-generation, source-success, validity, lifecycle, and freshness meanings, and keeps empty/error/unavailable states explicit. It draws no maps or inferred geometry and never opens returned source URLs.

The client calls only `GET /api/v1/context`, `GET /api/v1/events`, `GET /api/v1/events/{event_id}`, and `GET /api/v1/events/{event_id}/history`. API origin is set at build/run time with `API_ORIGIN`; it has no baked-in service host. Release builds require HTTPS. The debug-only local HTTP option is limited in Dart and Android network configuration to `localhost`, `127.0.0.1`, and `10.0.2.2`. Returned IDs and strict date components are validated, response errors are sanitized, pagination is bounded, and request generations discard stale context/detail/history/list results.

Optional interests stay in a Waspada-owned preferences key. Typed place, service, institution, and audience fields match only the same field across event, claim, and impact scopes; category match is exact. Text uses Unicode NFC, outer trim, and lowercase, matching the current L4 normalizer without collapsing internal whitespace. Canonically equivalent interests do not create duplicate chips or relevance reasons. Retry reads are blocked for unsaved or in-progress edits, save and clear operations are serialized, and removal is verified. Android app backup is disabled and the preferences file is excluded from legacy backup and Android 12+ cloud/device transfer. The app manifest requests `INTERNET`; the merged AndroidX manifest also defines an app-scoped signature permission for non-exported dynamic receivers, with no location or other user-facing permission.

## Checks run

Toolchain: Flutter 3.47.7, Dart 3.13.5, OpenJDK 21, Android API 36/build-tools 36.0.0, and Flutter-pinned NDK 28.2.13676358 (r28c). Android Gradle memory settings are capped at a 2 GiB Gradle heap, 1 GiB metaspace, two workers with parallel execution off, and a 1 GiB Kotlin daemon heap. Idle task-owned Gradle/Kotlin daemons were stopped after the build to release WSL memory.

- `flutter pub get` — passed; `pubspec.lock` is committed. `unorm_dart 0.3.2` is pinned to match backend NFC normalization.
- `dart format lib test` — passed; no changes needed at final check.
- `flutter analyze` — passed with no issues.
- `flutter test --reporter expanded` — all 23 API, preference, stale-retry/save race, async-generation, semantics-state, and widget tests passed, including 320 logical px at 2× text.
- `flutter build web --debug --no-web-resources-cdn --dart-define=API_ORIGIN=http://localhost:55173 --dart-define=ALLOW_INSECURE_DEBUG_ORIGIN=true` — passed after final source changes. The ignored preview output is `apps/mobile/build/web`.
- Root-side headless preview of the initial client build confirmed `/context` and `/events` returned HTTP 200 through the local Vite proxy and reviewed the landing screenshot. The final preferences-only changes were rebuilt; a second screenshot pass was not run.
- `flutter build apk --debug` — passed after final source changes in 69.2 seconds. APK size is 168,928,107 bytes; SHA-256 is `ae514c7a9cdf36867e7800b11fb581fdc24747dac1aa32f47202b1093152b29d`. The ignored APK is `apps/mobile/build/app/outputs/flutter-apk/app-debug.apk`.
- `git diff --cached --check` — passed before both implementation commits.

The Android build emitted a non-fatal SDK XML v4 compatibility warning from the installed command-line tooling. The shared SDK already contains API 36, build-tools 36.0.0, and NDK 28.2.13676358; no duplicate SDK installer was used. Generated build outputs and signing/local configuration remain ignored.

## Limits

No Android device or emulator, TalkBack/screen reader, live API origin, hosted deployment, or human usability study was exercised. The APK is a local debug validation build, not a signed release. The headless web screenshot does not establish Android device/browser, screen-reader, or human usability results; the widget suite checks the stated narrow viewport and text scale without layout exceptions. The checked-in Worker remains demo/synthetic and no source connector was activated by this work.
