# Accounts and onboarding

AUTH-PW-01 · 11 November 2026. Username and password accounts are the only sign-in. Google sign-in is removed from the server, the web client and the Android client. Decision: [ADR-060](decisions/ADR-060-password-accounts.md). The earlier decision [ADR-059](decisions/ADR-059-google-accounts-and-onboarding.md) still applies to roles, onboarding and web administration; its Google part is superseded.

Public reports, the map, history and device-local interests work without an account on the web and on Android.

## What each role can do

| Role | Web | Android |
| --- | --- | --- |
| Visitor, no account | Public reports, evidence, history and map; device-local interests and the introduction; can create an account or sign in | Public reader, device-local interests and the read guide. No sign-in |
| User | Visitor features plus own profile, password change, logout and onboarding completion | Public reader only |
| Moderator | User features plus the moderation review screen (`#tinjau-bukti`) and moderation API. Requires an active moderator or admin role | None |
| Admin | Moderator features plus the account list, and role or active-state changes for another account with a reason and expected version | None |

Rules that the code enforces:

- Self-registration always creates role `user`. A `role` field in the request body is ignored.
- Moderator and admin roles come only from operator provisioning or from an admin changing another account in the web. An admin cannot change their own account; the store returns a conflict.
- Every protected request reads the current account state (role, active flag and dataset) from the database.
- A role alone never publishes or edits an incident. Moderation actions still pass the publication gate.
- Account features never ask for an email address.

## Onboarding

Onboarding explains event status, evidence freshness, optional device-local interests and privacy. A visitor can finish it without an account or any write. An account completion saves only the onboarding version and time. Interests are not uploaded or synchronized, and no device-location permission is requested. Clearing local interests is separate from logout and does not delete the server account.

## Sign up and sign in (web)

- **Username:** 3 to 32 characters: lowercase letters, digits, `.` or `_`. The server trims and lowercases the input before it checks the format.
- **Password:** 10 to 256 characters. Length is the only rule; the service imposes no composition rules. There is no email, phone number or recovery address.
- **Stored:** username, display name (defaults to the username), role, active flag, onboarding state, and a PBKDF2-SHA256 hash with 100,000 iterations, a 16-byte random salt and a 32-byte derived key, computed with WebCrypto. The plaintext password is not stored. New password accounts have no email.
- **Login failures:** an unknown username and a wrong password return the same response. An unknown username is checked against a dummy hash so the response time is similar.
- **Throttles:** 12 login attempts per trusted client and 12 per username in a 10-minute window; 6 registrations per client and 6 password changes per account in the same window. Both login throttles are consumed on every attempt.
- **Sessions:** a web session uses the cookie `__Host-waspada_session` on HTTPS origins (Secure, HttpOnly, SameSite=Strict). Loopback development uses `waspada_session_dev`. A session expires after 30 minutes without use or 8 hours after sign-in. Signing in rotates away any earlier cookie session.
- **Browser writes:** register and login require the exact application Origin and the header `X-Waspada-Request: 1`. Password change and logout require the exact Origin and the session's `X-CSRF-Token`.
- **Password change:** requires the current password. It revokes every other session of that account and keeps the current one.
- **Not provided:** password reset, email recovery, multi-factor sign-in, and any operator reset command. A forgotten password cannot be recovered by the service in this change.

## Run the synthetic demo in WSL

Use Ubuntu-26.04 and the native Node 24 runtime. From `/mnt/d/Projects/RPL`, terminal 1:

```sh
export PATH=/home/perry/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin
npm run accounts:local -- --enable --demo --state accounts-demo
```

Terminal 2:

```sh
export PATH=/home/perry/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin
WASPADA_LOCAL_ACCOUNTS=true npm run dev
```

Open [127.0.0.1:5173](http://127.0.0.1:5173/#masuk). The demo seeds three synthetic accounts, `demo.warga` (user), `demo.moderator` and `demo.admin`, with the documented synthetic password in `tools/accounts/demo-accounts.ts`. These accounts exist only in the demo dataset and are never created in the live dataset. The local accounts server listens on :8789, and Vite proxies `/api/v1/auth` and `/api/v1/account` to it.

State lives under `.codex-build/accounts/<state>`. Stop the process with Ctrl+C before reopening the same state.

## Operator setup for hosted accounts (not performed)

No hosted database, Worker secret or account has been created by this change. Before any hosted account use:

1. Apply migrations `036_accounts` and `045_password_accounts` to the intended database as an explicitly authorized deployment step. Migration 045 is additive: it makes identity columns nullable and adds `username` and `password_hash` with their constraints.
2. Grant `waspada_auth_service` to the dedicated login role used by `AUTH_HYPERDRIVE`, after the migration: `GRANT waspada_auth_service TO waspada_auth_login;`. Do not reuse the reader, ingestion, model, investigation or publication credentials.
3. Set `AUTH_ENABLED=true`, `AUTH_APP_ORIGIN` to the exact HTTPS origin without a path, and the `AUTH_HYPERDRIVE` binding. Use the dashboard secret mechanism or an ignored `.dev.vars`; see [`apps/worker/.dev.vars.example`](../apps/worker/.dev.vars.example). No Google client ID or secret is used.
4. Create the first administrator with the operator script `npm run accounts:seed-admin` (see `tools/accounts/seed-admin.ts`). It creates the account only when the username is free, and it never changes an existing account. The local live server reads `WASPADA_ADMIN_USERNAME` and `WASPADA_ADMIN_PASSWORD` from `.env.local` for the same purpose.
5. Hosted behavior is unverified. The CPU cost of 100,000 PBKDF2 iterations on the Cloudflare Workers Free plan, Neon grants and login, and browser cookies on the deployed domain each need their own measurement. Do not claim hosted readiness from local tests.

## Android

The Android client is public-read only. It reads `/api/v1/context` and `/api/v1/events`, keeps interests on the device, and offers the read guide. It has no sign-in, no account request and no Google SDK. Build and run commands are in [`apps/mobile/README.md`](../apps/mobile/README.md).

## Security and verification boundary

- Responses from account routes are `no-store`; request bodies, responses and pages are bounded.
- Privileged changes require an expected version and a reason, revoke the target's sessions, and are written to the audit trail.
- Password hashes, plaintext passwords, session tokens and CSRF tokens are never logged or returned except the session CSRF token to its own session.
- Routine checks use mocks and fixtures with no external network. Local results do not establish hosted behavior, the CPU budget, or a real browser on the deployed domain.
