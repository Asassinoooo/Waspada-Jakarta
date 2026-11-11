# Waspada Jakarta — Flutter client

The Flutter app is a public reader. It shows reports, evidence, and freshness from the public `/api/v1/context` and `/api/v1/events` endpoints. Local interests, the read guide, and the privacy notes work without any account.

The app has no sign-in. It does not call the account routes (`/api/v1/auth/*` or `/api/v1/account/*`), does not hold a session or token, and does not use a Google SDK. Username and password accounts are handled by the responsive web client in `apps/web`; the decision is recorded in `docs/decisions/ADR-060-password-accounts.md`.

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

To run on a configured Android device, supply the HTTPS API origin at build time:

```sh
flutter run --dart-define=API_ORIGIN=https://your-api-origin.example
```

`API_ORIGIN` must be an origin without a path, query, credentials, or fragment. Release builds require HTTPS. A debug build can read local public API fixtures over HTTP to `localhost`, `127.0.0.1`, or `10.0.2.2` only when `ALLOW_INSECURE_DEBUG_ORIGIN=true` is also passed. Release builds set Android cleartext traffic to false. Android backup is disabled, and shared-preference files are excluded from backup and device transfer.

Interests stay in local app storage (`shared_preferences`) on the device and are never uploaded. The app does not request location.

The Android min SDK is 24 or higher. Release signing remains an external build configuration.

## Check

```sh
flutter analyze
flutter test
flutter build apk --debug
flutter build web
```

A local build does not establish the live API, Android device behavior, TalkBack, hosted deployment, or store-release readiness.

## Feature parity

| Capability | Flutter client | Notes |
| --- | --- | --- |
| Public dataset context and event browsing | Supported | Existing exact public API routes and source status remain unchanged; dataset mode is confirmed before preview data is shown. |
| Detail, evidence, and reviewed history | Supported | Renders only returned fields; source URLs remain selectable text and are never launched by the app. |
| Category, lifecycle, freshness, and search filters | Supported | Sent only as documented public list query fields. |
| Local interests and category matching | Supported | Saved on device, matched against fetched public fields, and never uploaded. |
| Read guide and interest privacy | Supported | Read guide covers how to read event status, evidence freshness, and personal relevance. Interest privacy is described in Minat dan privasi. No account request. |
| Account sign-in, registration, password change, logout | Not provided | Public-read only. Use the web client for username and password accounts. |
| Maps/geometry | Deferred | No geometry is drawn or inferred. |
| Briefings, update polling, subscriptions, push, background monitoring | Deferred | No briefing or update endpoint is called. |
| Offline incident cache | Deferred | Event, evidence, detail, and history responses are not persisted. |

## Known limitations

- The native client has no account surface. Moderator and administrator tools are web-only.
- `pubspec.yaml` still lists `flutter_secure_storage`. No current source file imports it, because the account token store was removed with the sign-in flow. Removing the package is a separate dependency change.
- Live data remains subject to server-selected dataset mode and source/publication policy. A DEMO or synthetic/historical dataset is identified in the UI and is never presented as live.
- Scope-name matching uses `unorm_dart` for Unicode NFC, then trims outer whitespace and lowercases before exact comparison. It does not collapse internal whitespace, apply aliases, or compare one interest field against another; category matching is exact.
- App backup is disabled. Interest values stay in local app storage and are not synchronized.
- The API does not provide a source-fetch timestamp on each event detail. The app labels context generation and source `last_success_at` independently and does not invent an event fetch time.
- Android device, screen-reader, human usability, live-origin, hosting, offline, and release checks require separate evidence and have not been inferred from local tests.
