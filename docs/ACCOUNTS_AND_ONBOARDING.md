# Accounts and onboarding

AUTH-01 · 15 October 2026. Local account implementation is integrated; [assignment and contract](assignments/AUTH-01-ACCOUNTS-ONBOARDING.md), [decision](decisions/ADR-059-google-accounts-and-onboarding.md), [verification handoff](assignments/AUTH-01-ACCOUNTS-ONBOARDING-HANDOFF.md). Google OAuth clients are not configured, per Team12's answer. The local demo uses authored synthetic identities; it does not authenticate a real Google account.

## What each role can do

| Role | Resident features | Additional web access | Android |
| --- | --- | --- | --- |
| Visitor, no account | Public reports/evidence/history, existing map, device-local interests and optional introduction | None | Existing public reader/interests/guide and guest introduction |
| User | Visitor features plus own account/session and saved onboarding version/time | Own profile/logout | Own profile/logout/onboarding; protected session storage |
| Moderator | User features | Existing read-only evidence-review example | Same resident/account features; no moderation dashboard |
| Admin | User features | Existing read-only dashboard, bounded account list, role/active-state changes for another account with reason/version | Same resident/account features; no admin dashboard or role-management controls |

The Google provider proves identity; the server assigns role. New Google subjects are users. Roles are scoped to the server-selected demo/live realm. Email matching, local-storage edits, token claims or onboarding inputs cannot grant a privileged role. No role here enables publication, source approval, correction or retraction. Those routes remain outside this slice.

Onboarding explains status/evidence/freshness, optional device-local interests and privacy. Visitors can finish without registration or writes. Account completion saves only its version and time; the account separately retains verified Google identity, display name/email, role/status and session records. Interests are not uploaded or synchronized. No device-location permission is requested. Clearing local interests is distinct from logout and does not delete the server account.

## Run the synthetic demo in WSL

Use Ubuntu-26.04 and the existing native Node runtime. From `/mnt/d/Projects/RPL`, terminal1:

```sh
export PATH=/home/perry/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin
npm run accounts:local -- --enable --demo --state accounts-demo
```

Terminal2:

```sh
export PATH=/home/perry/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin
WASPADA_LOCAL_ACCOUNTS=true npm run dev
```

Use [127.0.0.1:5173](http://127.0.0.1:5173/#masuk). The development login opens an explicit **DEMO LOKAL — akun rekaan, bukan Google** consent page with three pre-provisioned identities. Choosing one signs into that existing synthetic account; this is not a public role-selection signup. The demo is loopback-only, opt-in, separate from Worker production authentication and never calls Google. Native Google login is unavailable in this Node fixture profile; Android tests inject fake SDK/API/storage instead.

State is owned under `.codex-build/accounts/<state>/pg`, with a synthetic profile marker and exclusive process lock. No source, evidence, incident, publication or private AI state is opened. Three identities are seeded only before the profile first becomes ready; reopening preserves later role/onboarding changes. Stop with Ctrl+C before reopening the same state. A second owner is rejected. After a force-killed process, inspect the PID in that profile's `owner.lock` and verify it is no longer running before removing that exact stale lock; never remove a running owner's lock. No recursive cleanup is needed for startup.

Without the explicit account demo, the checked-in Worker keeps auth disabled. Public browsing still works and login explains its unavailable configuration. The account interface uses one utility destination; the four primary navigation groups stay intact.

## Prepare real Google login later

No console, hosted resource or credential was created by this implementation. Team12 must prepare its own Google project/consent screen and web/Android OAuth registrations. Basic identity scopes are `openid email profile`; no Drive, Gmail, precise location or unrelated service access is requested. In a testing consent project, add the intended test users as required by its settings.

1. Create a **Web application** OAuth client. Configure the exact deployed callback `https://YOUR_APP_ORIGIN/api/v1/auth/google/callback`. The backend uses authorization-code OIDC with PKCE/state/nonce and explicit signed-ID-token validation. Keep the client secret server-side.
2. Create an **Android** OAuth client for package `id.waspada.waspada_jakarta_mobile` and the certificate SHA fingerprint of the intended debug or release signing key. Obtain fingerprints with the existing Android Gradle signing report; debug and release identities differ.
3. Configure the SDK's `GOOGLE_SERVER_CLIENT_ID` with the **web/server** client ID. The native ID token's audience must be that ID. `AUTH_GOOGLE_ANDROID_CLIENT_ID` can additionally pin Android's authorized-presenter claim when it differs from the server audience. Never put the web client secret into Dart defines or APK assets.
4. Copy [the safe Worker template](../apps/worker/.dev.vars.example) into an ignored `.dev.vars` locally, or use the hosting secret mechanism later. Set `AUTH_ENABLED=true`, the exact HTTPS `AUTH_APP_ORIGIN`, `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`, and the intended native audience/presenter IDs. Local and deployed origins/callbacks are separate registrations. The synthetic demo requires none of these values.
5. Apply canonical migration036 to the intended database only as an explicitly authorized deployment step. It creates private auth tables and a NOLOGIN/NOINHERIT `waspada_auth_service` capability. A dedicated restricted database LOGIN used by `AUTH_HYPERDRIVE` must be granted membership **after** migration (`GRANT waspada_auth_service TO waspada_auth_login;`). Do not reuse the public-reader, ingestion, model, investigation or publication credentials. Repository transactions use `SET LOCAL ROLE waspada_auth_service`; missing membership fails closed. No hosted login/grant/binding is configured here.
6. Initial privileged access is an explicit operator provisioning action through `createAccountStore(executor, datasetMode).provisionAccount({identity,role,reason,now})`, after validating the exact Google issuer/subject out of band. There is no public bootstrap endpoint or automatic first-user admin. Subsequent account changes use the authenticated web admin endpoint with reason/version, current-actor validation, audit and target-session revocation.

Only set up the real credentials after reviewing the completed local result. Real Google success, Cloudflare CPU/free quota, Neon login/grants, browser cookies on the deployed domain and Android device sign-in still require their own verification. Configuring identity in demo mode does not activate real-source ingestion or public warnings.

## Android commands

The Flutter baseline from UX source `cad1d2e` is integrated under `apps/mobile`. Use the existing Linux SDK, not Windows Flutter:

```sh
export PATH=/home/perry/.local/opt/waspada-flutter-3.47.7/flutter/bin:$PATH
export ANDROID_HOME=/home/perry/.local/opt/waspada-android-sdk
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
cd /mnt/d/Projects/RPL/apps/mobile
flutter pub get
flutter analyze
flutter test
flutter build apk --debug
```

For a real configured HTTPS account API, launch with public identifiers only:

```sh
flutter run --dart-define=API_ORIGIN=https://YOUR_APP_ORIGIN \
  --dart-define=GOOGLE_SERVER_CLIENT_ID=YOUR_WEB_CLIENT_ID.apps.googleusercontent.com
```

Native authentication uses the official Google SDK, sends its ID token to the fixed native exchange, then keeps only the app's separate opaque session in OS secure storage. Fixed-origin account requests reject redirects. Browser auth uses cookies, not the native token API. Android app backup stays disabled; no native admin/moderation controls are included. The Flutter reader's native geometry/map feature remains deferred from its baseline; this task adds account/onboarding parity, not a new native map implementation.

## Security and verification boundary

Web session tokens are random and hashed at rest; production cookies are host-only/Secure/HttpOnly/Strict. OAuth-attempt cookies use Lax to permit the Google callback, and their persisted state/PKCE/nonce are short-lived and consumed once. The previous web session is bound at login start and revoked atomically on successful rotation even when the Strict cookie is absent on callback. Failed login preserves the prior session. Web writes require same-origin Origin and `X-CSRF-Token`. Idle expiry is30minutes of account API inactivity, absolute expiry8hours; confirmed logout, disablement or role changes revoke sessions. Every request reads current account state and realm. Native bearer sessions cannot call admin APIs. Android clears its local token even when offline logout cannot confirm server revocation; an unconfirmed server session then remains subject to expiry. Web reports failed logout and offers session checking.

Identity proofs/provider errors are not logged, put in Git, exposed through public incident responses or saved as incident evidence. Account responses are no-store, inputs/outputs/pages are bounded and login throttles durable. Privileged changes require an expected version and reason, reject self modification, revoke affected sessions and append an audit record. Google validation uses maintained libraries and local signed fixtures for routine checks, never a paid model or live source.

The handoff records command results, package SHAs, independent review, failed checks and remaining gates. A successful local build is not a deployed authentication service or real-device OAuth proof.
