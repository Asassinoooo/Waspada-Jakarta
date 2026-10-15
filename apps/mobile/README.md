# Waspada Jakarta — Flutter client

Account-free Flutter client for reading the existing public API. The mobile app is an independent Android client; it does not change the web application or Worker API.

## Setup

Install the official stable Flutter SDK and Android command-line build tools. From this directory:

```sh
flutter pub get
flutter run --dart-define=API_ORIGIN=https://your-api-origin.example
```

The origin is intentionally not preconfigured. Until `API_ORIGIN` is supplied as an absolute HTTPS origin, the app displays a configuration-unavailable state and offers retry. Do not put credentials in the origin. For emulator development only, an HTTP loopback origin can be enabled in a debug build with both defines below; the app permits only `localhost`, `127.0.0.1`, or Android emulator host `10.0.2.2` in this mode:

```sh
flutter run --dart-define=API_ORIGIN=http://10.0.2.2:8787 --dart-define=ALLOW_INSECURE_DEBUG_ORIGIN=true
```

Release builds always require HTTPS. Android debug builds also scope cleartext network access to these local hosts; release manifests keep Android's default cleartext denial. This exception does not configure access to arbitrary hosts.

## Check

```sh
flutter analyze
flutter test
flutter build apk --debug
```

Builds and generated dependency metadata remain local and ignored. A successful local build does not establish Android device, TalkBack, live API, hosted deployment, or store-release readiness.

## Feature parity

| Capability | Flutter client | Notes |
| --- | --- | --- |
| Public dataset context | Supported | Exact `GET /api/v1/context`; reports are withheld until mode is confirmed. |
| Public event list | Supported | Exact `GET /api/v1/events`; one bounded page at a time, with explicit “Muat lainnya”. |
| Category/lifecycle/freshness/search filters | Supported | Sent only as documented public list query fields. |
| Detail and evidence | Supported | Exact `GET /api/v1/events/{event_id}`; renders only returned fields. Source URLs are shown as selectable text and are never launched by the app. |
| Reviewed public history | Supported | Exact `GET /api/v1/events/{event_id}/history`; separately recoverable from detail. |
| Local interests and category matching | Supported | Stored on device with app backup disabled; category is exact, and each typed scope field matches only the same field in returned event/claim/impact scopes. Names use NFC → trim → lowercase, matching the L4 local normalization. Saving never sends interests. |
| Read guide and privacy controls | Supported | Local preference key can be cleared; network use and storage limits are explained. |
| Maps/geometry | Deferred | No geometry is drawn or inferred. |
| Briefings, update polling, subscriptions, push, background monitoring | Deferred | No briefing or update endpoint is called. |
| Accounts and moderator tools | Deferred | Public browsing is account-free; moderator demo remains in the web client. |
| Offline incident cache | Deferred | Event, evidence, detail, and history responses are not persisted. |

## Known limitations

- Live data remains subject to server-selected dataset mode and source/publication policy. A DEMO or synthetic/historical dataset is identified in the UI and is never presented as live.
- Scope-name matching uses `unorm_dart` for Unicode NFC, then trims outer whitespace and lowercases before exact comparison. It does not collapse internal whitespace, apply aliases, or compare one interest field against another; category matching is exact.
- App backup is disabled and the shared-preferences file is excluded from legacy backup and Android 12+ cloud/device-transfer rules. The client does not synchronize preference values.
- The API does not provide a source-fetch timestamp on each event detail. The app labels context generation and source `last_success_at` independently and does not invent an event fetch time.
- Android device, screen-reader, human usability, live-origin, hosting, offline, and release checks require separate evidence and have not been inferred from local tests.
