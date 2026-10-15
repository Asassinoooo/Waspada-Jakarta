# ADR-059 — optional Google accounts and cross-platform onboarding

15 October 2026. Decision accepted; local implementation integrated under [AUTH-01](../assignments/AUTH-01-ACCOUNTS-ONBOARDING.md). User explicitly chose Google login, retained account-free public browsing, and requested Android Flutter plus responsive web parity without a mobile admin dashboard. Google clients are not prepared; user chose the synthetic local demo and configuration guide first. [Handoff](../assignments/AUTH-01-ACCOUNTS-ONBOARDING-HANDOFF.md) separates verified local behavior from external gates.

## Decision

Introduce optional identity and first-use guidance. Visitors can read published reports/maps/history and save device-local interests. A verified new Google identity receives only `user`; `moderator` and `admin` are server-managed roles. Identity is bound to provider issuer/subject rather than matching email. Onboarding explains status/evidence/freshness, local interests and privacy; it stores its completion version/time without uploading interests or requesting precise location. A single account utility preserves the four primary web navigation groups.

Web uses authorization-code OIDC with state/PKCE/nonce and same-origin opaque server sessions; native Android uses Google's SDK and a separately verified token exchange, with an opaque native session held in OS secure storage. Account storage is separate from incident evidence and source ingestion. Current roles/account status/dataset are checked at each protected API request. Web admin can manage another account with reason/version and session revocation; native sessions cannot invoke admin APIs. Restricted initial provisioning is an operator action, never automatic first-user promotion. All sessions are revocable and expire; user-supplied roles are ignored/denied.

This revises the no-login/no-public-account scope of ADR-006/028. Their publication, source-approval, correction/retraction and evidence-gate rules remain: identity is not permission to publish. No such mutation is enabled by this decision. Read-only illustrative operations stay labelled; private monitoring still needs its own authenticated data contract.

Use existing PostgreSQL/Neon-compatible persistence and Cloudflare-compatible Web APIs plus maintained OIDC/JOSE code. No additional paid auth service is required by the design. Free-tier CPU/hosted behavior is a verification gate, not established by a local build. Local integration uses an explicitly enabled loopback PGlite harness; mocked identities are synthetic-only and cannot become production sign-in. Missing provider settings fail closed for account features while public browsing continues.

## Trade-offs and external gates

Google login avoids password storage/reset/email infrastructure, but requires configured web/Android OAuth clients, consent branding, exact web callback, Android package/signing certificate and a real device validation. These are external service changes and remain separate from local implementation. Cookies protect the browser from JS-readable bearer storage; native bearer storage uses Android's protected key storage. No Google refresh/access token is retained for unrelated services. Local interests do not automatically follow an account across devices.

## Primary sources checked 15 October 2026

- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect): setup, authorization-code server flow, identity validation and issuer/subject identity.
- [Google Android backend authentication](https://developers.google.com/identity/sign-in/android/backend-auth): SDK ID token transfer and server verification rather than trusting a client user ID.
- [openid-client](https://github.com/panva/openid-client): maintained standards-based Web API client; npm resolved6.8.8 with JOSE/OAuth dependencies, pinned for this implementation.
- [google_sign_in](https://pub.dev/packages/google_sign_in): Flutter Google plugin7.2.0 and server client configuration.
- [flutter_secure_storage](https://pub.dev/packages/flutter_secure_storage): native secure storage; implementation must record its compatible pinned version.
- [Cloudflare Worker limits](https://developers.cloudflare.com/workers/platform/limits/): free-tier CPU/request limits require hosted checks before deployment claims.

The browser-write header is `X-CSRF-Token`; production authorization URLs are pinned to Google's exact OIDC path. Web proof validation explicitly enables signed-ID-token checks. Native audience is the SDK's web/server client ID, with an optional configured Android authorized party; arbitrary parties fail closed. Prior sessions are captured at login start for rotation even when Strict cookies are absent from the cross-site callback. Provider discovery failure is retryable rather than permanently poisoning the warm runtime. Private roles are scoped to the server-selected dataset at repository creation. Package versions are pinned: openid-client6.8.8, jose6.2.12, google_sign_in7.2.0 and flutter_secure_storage11.2.0.

Exact API contracts, assignments, test evidence and remaining gates live in the AUTH-01 assignment/handoff. No actual Google success, deployed session service, native device sign-in or full MOD-01 completion is claimed.
