# Waspada Jakarta — Flutter client

The Flutter app preserves account-free public browsing and adds optional Android Google sign-in, account status, and three-step onboarding. Public reports and interests remain usable without an account. The Flutter web target keeps the responsive public reader and guest onboarding; browser account login is owned by the responsive web client in `apps/web`.

## Setup

Use the existing WSL Ubuntu 26.04 toolchain: Flutter 3.47.7 stable, Dart 3.13.5, Java 21, and the Android SDK. From the repository root in WSL:

```sh
export PATH="/home/perry/.local/opt/waspada-flutter-3.47.7/flutter/bin:$PATH"
export ANDROID_HOME=/home/perry/.local/opt/waspada-android-sdk
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
cd apps/mobile
flutter pub get
```

To run on a configured Android device, supply the HTTPS API origin and public web OAuth client ID at build time:

```sh
flutter run \
  --dart-define=API_ORIGIN=https://your-api-origin.example \
  --dart-define=GOOGLE_SERVER_CLIENT_ID=your-web-oauth-client-id
```

The OAuth client ID is public app configuration, not a secret. It is supplied at build time and is not checked into the app. Register Android package `id.waspada.waspada_jakarta_mobile` and the SHA fingerprints for each signing configuration in the Google provider console. No Google configuration is bundled. If either Android OAuth registration or `GOOGLE_SERVER_CLIENT_ID` is missing, login stays unavailable and public browsing continues.

When someone signs in, the server verifies and stores the Google identity, display name, email, server-assigned role, and onboarding version/completion time. Interests remain on the device and are never uploaded. Android stores only the opaque server session token in secure storage; logging out clears that token without clearing local interests. The app does not request location.

`API_ORIGIN` must be an origin without a path, query, credentials, or fragment. Release and account requests require HTTPS. The existing opt-in HTTP loopback mode is for reading local public API fixtures only; it cannot send a Google ID token to the account API. Release builds set Android cleartext traffic to false. `flutter_secure_storage` 11.2.0 requires Android API 24 or newer. Android backup is disabled and shared-preference files are excluded from backup and device transfer.

Package versions recorded when implementation began: `google_sign_in` 7.2.0 and `flutter_secure_storage` 11.2.0. `pubspec.lock` records the resolved transitive plugin versions. The Android min SDK is at least 24 to satisfy secure-storage support. Release signing remains an external build configuration.

The verified local debug build used Android SDK Platform 35 (revision 2), Build Tools 36.0.0, and CMake 3.22.1 within the existing SDK. Gradle may install missing build components into that configured SDK; no emulator is needed to build the APK.

## Check

```sh
flutter analyze
flutter test
flutter build apk --debug
flutter build web
```

A local build does not establish Google provider configuration, Android device behavior, TalkBack, live API, hosted deployment, or store-release readiness. No live Google sign-in was run for this implementation.

## Feature parity

| Capability | Flutter client | Notes |
| --- | --- | --- |
| Public dataset context and event browsing | Supported | Existing exact public API routes and source status remain unchanged; dataset mode is confirmed before preview data is shown. |
| Detail, evidence, and reviewed history | Supported | Renders only returned fields; source URLs remain selectable text and are never launched by the app. |
| Category, lifecycle, freshness, and search filters | Supported | Sent only as documented public list query fields. |
| Local interests and category matching | Supported | Saved on device, matched against fetched public fields, and never uploaded. |
| Read guide, privacy, and optional onboarding | Supported | Three steps cover distinct event status, evidence freshness, personal relevance, local interests, and privacy. Guest completion makes no account request. |
| Google account on Android | Optional | Official `google_sign_in` SDK exchanges an ID token over HTTPS; only the separate server-issued opaque session token is retained in `flutter_secure_storage`. |
| Account session and onboarding | Supported on Android | Restores, expires, retries offline, completes version 1, logs out, and displays the server-assigned role. The app provides no role selector, admin dashboard, or moderation controls. |
| Flutter web account auth | Deferred to `apps/web` | The Flutter web build is guest-only; it does not store browser tokens or cookies or call the native token exchange. |
| Maps/geometry | Deferred | No geometry is drawn or inferred. |
| Briefings, update polling, subscriptions, push, background monitoring | Deferred | No briefing or update endpoint is called. |
| Offline incident cache | Deferred | Event, evidence, detail, and history responses are not persisted. |

## Known limitations

- Google Android OAuth registration, server audience configuration, package SHA fingerprints, Android device sign-in, and release signing need external configuration and have not been verified here.
- The native client supports Android accounts. The responsive browser account flow remains in `apps/web` and uses the browser-specific contract.
- Live data remains subject to server-selected dataset mode and source/publication policy. A DEMO or synthetic/historical dataset is identified in the UI and is never presented as live.
- Scope-name matching uses `unorm_dart` for Unicode NFC, then trims outer whitespace and lowercases before exact comparison. It does not collapse internal whitespace, apply aliases, or compare one interest field against another; category matching is exact.
- App backup is disabled. Interest values stay in local app storage and are not synchronized. Session tokens use encrypted secure storage and are not written through the interests repository.
- The API does not provide a source-fetch timestamp on each event detail. The app labels context generation and source `last_success_at` independently and does not invent an event fetch time.
- Android device, screen-reader, human usability, live-origin, hosting, offline, and release checks require separate evidence and have not been inferred from local tests.
