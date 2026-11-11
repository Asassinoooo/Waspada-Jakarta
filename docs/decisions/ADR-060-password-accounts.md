# ADR-060 — Username and password accounts

- **Status:** Accepted on 11 November 2026 under AUTH-PW-01. Supersedes the Google sign-in part of [ADR-059](ADR-059-google-accounts-and-onboarding.md); the roles, onboarding and web-administration parts of ADR-059 remain.
- **Date:** 2026-11-11
- **Owner:** Team 12
- **Scope:** Sign-in for the web client and the Android client; account-v1 routes under `/api/v1/auth` and `/api/v1/account`. Public incident contracts, publication authority and source rights are unchanged.

## Context

Google sign-in needed a configured OAuth client, consent setup and a native SDK path that Team 12 had not prepared. The local demo used synthetic identities only. On 11 November 2026 Team 12 decided to replace Google with username and password accounts. Public browsing must keep working without an account, and an account must never grant publication or source-approval rights.

## Decision

1. **Single sign-in method.** Username and password are the only sign-in. Google OAuth routes, the ID-token exchange and the Android Google SDK are removed. Existing rows from migration 036 remain valid.
2. **Additive schema.** Migration 045 makes the identity columns and `email` nullable and adds `username` and `password_hash` with format and pairing constraints. Migration 036 is not edited. A password account has no email.
3. **Username.** 3 to 32 characters from `[a-z0-9_.]`, after trimming and lowercasing. Uniqueness is per dataset.
4. **Password policy.** Length only: 10 to 256 characters, with no composition rules.
5. **Password hash.** PBKDF2-SHA256 with 100,000 iterations, a 16-byte random salt and a 32-byte key, computed with WebCrypto so the same code runs in Workers and Node. Stored form: `pbkdf2-sha256$<iterations>$<salt>$<key>`. Verification compares derived bytes in constant time, and stored iteration counts must fall between 10,000 and 1,000,000. An unknown username is verified against a dummy hash.
6. **Self-registration is always `user`.** A role field in the body is ignored. `moderator` and `admin` come only from the operator seed script or from an admin changing another account on the web, with a reason and expected version. An admin cannot change their own account.
7. **Sessions.** The session token is random and stored only as its SHA-256 hash. The CSRF token is random and stored with its session row. A web session uses an HttpOnly, SameSite=Strict cookie (`__Host-` and Secure on HTTPS). It expires after 30 minutes idle or 8 hours absolute. Login rotates away any earlier cookie session. A password change revokes the account's other sessions. Logout revokes the current session.
8. **Browser writes.** Register and login require the exact Origin and `X-Waspada-Request: 1`. Authenticated writes require the exact Origin and `X-CSRF-Token`.
9. **Throttles.** Login: 12 attempts per trusted client and 12 per username per 10 minutes, both consumed on every attempt. Registration: 6 per client per 10 minutes. Password change: 6 per account per 10 minutes.
10. **Client surfaces.** Account UI is web only. The Android client is public-read only: it calls `/api/v1/context` and `/api/v1/events`, has no account routes and no session store.
11. **Moderator-only surfaces.** Without a session they answer 401; with a session that lacks an active moderator or admin role they answer 403. The web shows sign-in or role copy for each case and does not crash.

## Trade-offs and gates

- There is no password reset, email recovery or multi-factor sign-in. A forgotten password cannot be recovered in this change, and no operator reset command exists.
- PBKDF2 at 100,000 iterations is CPU-intensive. The Cloudflare Workers Free CPU budget has not been measured, so this is a hosted gate. Stored hashes carry their iteration count, so the count can change later without invalidating existing hashes. No rehash-on-login path exists yet.
- Accounts created through Google before this change keep their identity and any email, and their login method is no longer offered. No path adds a password to such an account, so a password change for them returns the generic 403.
- The first administrator is created by an operator with `npm run accounts:seed-admin`, or by the local live server's `WASPADA_ADMIN_*` variables. The seed never modifies an existing account.
- Hosted deployment, Neon grants and login, and real browser cookies on the deployed domain are not verified here.

## Verification boundary

Recorded for AUTH-PW-01B: the web test suite (`apps/web/test/accounts.test.tsx`, `account-messages.test.ts`, `experience.test.tsx`, `moderator-review.test.tsx`, `embedding-visualization.test.tsx`), mobile `flutter analyze` and `flutter test`. Worker and database account suites were not run in the AUTH-PW-01B slice.
