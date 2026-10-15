# AUTH-01 — accounts and onboarding handoff

15 October 2026. Local slice delivered for optional Google identity, server roles and onboarding across responsive web and Android Flutter. Google OAuth clients are not configured: Team12 explicitly chose a synthetic local demo plus setup guide. Public browsing remains account-free. Hosted authentication, real Google/device success and incident publication are not claimed.

## Assignment, provenance and integration

Root read the software plan, backlog and relevant contracts, froze account-v1, then assigned three independent Luna/max branches/worktrees. A separate Luna/max reviewer inspected core/web/mobile and root composition; implementers did not approve their own work. No Astra escalation, subdelegation, provider call, deployment or hosted configuration occurred. Root copied reviewed commits to main and pushed checkpoint `5aed04e` successfully.

| Package / worktree under `.codex-build/worktrees/` | Agent commit and exact message | Root copy |
| --- | --- | --- |
| CORE / `auth-01-core` | `a7d2e49c12c6b9d2817966f39d09d87045aa38d4` — `feat(AUTH-01): add scoped account authentication core` | `89df74c` |
| CORE follow-up | `c74ae2618d93fe9309910567151e986f22b90035` — `fix(AUTH-01): match web CSRF header contract` | `5c820b5` |
| CORE historical fixtures | `4d95be96a47fc5596ed1a427c0309731511d0b74` — `test(AUTH-01): bound migration history fixtures` | `b817fad` |
| WEB / `auth-01-web` | `d6cf1e1de72d0e0c6c66f6e54ccd06d40394ae8c` — `feat(AUTH-01-WEB): add account onboarding and role-gated web pages` | `95e694e` |
| WEB privacy/URL/reflow | `6a93c206a04c1a9b8f14b48c64037203e558b74c` — `fix(AUTH-01-WEB): clarify account privacy and small-screen flow` | `9d7e048` |
| WEB enlarged shell | `d78c268cd73075bb7960f684583da5b8b1bf058d` — `fix(AUTH-01-WEB): reflow mobile shell at enlarged text` | `00c666f` |
| MOBILE baseline / `auth-01-mobile` | `002ba33884f61ab74d7e11edc7fb040ceaa9546b` — `chore(AUTH-01-MOBILE): import Flutter reader baseline from cad1d2ef` | `56b1067` |
| MOBILE feature | `2ece3612998ee6673b9109874287fe34f6be664e` — `feat(AUTH-01-MOBILE): add secure native accounts and onboarding` | `c92565d` |

The selective Flutter baseline imports only `apps/mobile/**` from UX source `cad1d2ef7776692ea8911d48e6fc161887df49af`; no source-branch backend/configuration was merged. Root planning commits: `1201b0f` — `docs(AUTH-01): assign Google accounts and cross-platform onboarding`; `01c8543` — `feat(AUTH-01): prepare isolated local account runtime and design`. Root composition: `5aed04e` — `feat(AUTH-01): compose durable synthetic account demo and app routes`. Original history/authorship remains intact.

## Changed paths and behavior

- `apps/db/migrations/036_accounts.sql`, `apps/db/src/accounts.ts`, `apps/db/test/accounts.test.ts`: separate private auth schema/capability, dataset-scoped identities/roles, hashed opaque sessions, one-use browser-bound login attempts, throttle, audit, versioned account updates and target-session revocation. Migration can run in an account-only database.
- `apps/worker/src/accounts/**`, `src/runtime/account-runtime.ts`, `src/contracts/accounts.ts`, account tests, Worker entry/environment/package and safe `.dev.vars.example`: OIDC code flow, explicit signed Google proof, fixed native audience/presenter, Origin/CSRF cookie writes, bearer-only native own-account actions, lazy fail-closed runtime. Non-account routes remain independent.
- Web account client/pages/styles/tests and existing App/main/help/privacy, package registration and opt-in Vite proxy: one Akun utility, three-step guest/account introduction, profile/logout, role-gated read-only shells, bounded desktop account management, unavailable/error/conflict states, local-interest privacy and narrow/200% reflow.
- `apps/mobile/**`: existing Flutter public reader plus official Android sign-in SDK, secure opaque-session storage, restore/expiry/offline/cancel/retry/logout and account onboarding. Displayed role is read-only; no native dashboard/moderation/account-management controls. Existing native maps, briefings, update polling and incident offline cache remain deferred.
- `tools/accounts/**`, root scripts, ignored local state: opt-in loopback service, fixed authored identities and explicit fictional consent, exclusive state ownership, separate persistent PGlite, no credentials or Google calls. Seed only before first ready marker, preserving subsequent role/onboarding changes.
- Software plan/backlog/architecture/UX/API/ADRs/README/reference register, [startup/setup guide](../ACCOUNTS_AND_ONBOARDING.md) and this record: updated scope, role/data boundaries, actual evidence and external gates.

New identities always become users. Moderator has read-only web evidence review; admin additionally has the existing read-only desktop dashboard and audited changes to another account. No self change, first-user promotion, role selector at signup, native admin API or publication authority. Event lifecycle/evidence/freshness/relevance and public DTOs remain unchanged.

## Actual verification

All project execution used WSL Ubuntu-26.04. Node24.21.0/npm11.19.0; pinned openid-client6.8.8, jose6.2.12 and PGlite0.5.8. Flutter3.47.7/Dart3.13.5, Java21; google_sign_in7.2.0 and flutter_secure_storage11.2.0. No LaTeX installed or compiled.

| Command / check | Actual result |
| --- | --- |
| `npm run typecheck` and `npm run build` | Pass across workspaces/tools; Vite build and Wrangler4.137.0 dry-run. Worker upload1172.01KiB, gzip230.95KiB; no deployed binding/resource. |
| `npm run test --workspace=@waspada/web` | 196/196 pass after final web changes. |
| `npm run test --workspace=@waspada/worker` | 533/533 pass after CSRF fix and normal test registration. |
| `npm run accounts:test` | Four adapter/config/synthetic-provider checks plus one separate durable HTTP/PGlite composition pass. |
| Independent reviewer focused checks | Core15/15, web account12/12, local adapter4/4, package typechecks; reviewer separately reran durable composition1/1 after CSRF fix and found no remaining account integration blocker. |
| Evaluation/AI test command from root `test` script | 41/41 pass with mocks; no real gateway/model/source calls. |
| `npm run smoke` | Pass: existing local shell/context/list/detail/history, demo labels/timestamps and honest empty evidence/geometry. |
| Production bundle inspection | Private local-pipeline route/endpoint and synthetic account-consent path excluded; admin bundle remains lazy. |
| Web headless Playwright | Ten mocked-account groups / ten screenshots, plus seven actual loopback HTTP/PGlite groups / four screenshots; zero page errors, external requests blocked. Root inspected desktop/mobile/320px200% captures and refined wrapping/stacking. |
| `flutter analyze` / `flutter test` / `flutter build apk --debug` | Root rerun passes: no analyzer issues,41/41 tests, debug APK163,241,039bytes at `apps/mobile/build/app/outputs/flutter-apk/app-debug.apk` (ignored). |
| Broader DB regression | Initial43/46 files passed; all three failing files then passed focused recovery: root migration/update fixtures23/23 and isolated outbox7/7. This covers all46 discovered files across the initial run and recovery; it is not a single clean full-suite run. The initial `npm test` remains a failed run. |
| `npm run pipeline:test` | 58/58 isolated synthetic cases pass, including collection during pending AI, long-wait lease renewal, restart/replay and private app composition. |
| Local documentation / ignore checks | Ten documents /478 local links and final diff checks pass. APK, Kotlin cache, state and `.dev.vars` are ignored. |

The actual HTTP composition covers synthetic start/consent/callback, onboarding via real shared handler/store, user denial/admin list, role update and target-session revocation, owner-lock denial, close/reopen preserving onboarding/roles/session, logout and demo/live separation. Browser QA adds actual callback navigation, HttpOnly/Strict cookie, page reload, denied user shell, admin read-only dashboard and mobile own profile without admin controls. Routine provider tests use locally signed JWT/JWKS/OIDC fixtures for signature/nonce/audience/authorized-party rejection. No evidence is inferred from mere valid JSON.

Ignored receipts: `.codex-build/auth-01-web-qa/receipt.json`, `.codex-build/auth-01-durable-browser/receipt.json`, corresponding screenshots and `.codex-build/auth-01-full-tests.log`. Synthetic accounts are under `.codex-build/accounts/auth-01-review`; that state is separate from sources/private proposals/publication. Headless QA did not control the user's computer.

## Failed checks and corrections

The real composition initially returned403 because web sent `X-CSRF-Token` while the server expected a different header. Core was corrected to the standard frozen header only; tests reject missing/wrong/legacy headers and the composition now passes onboarding, role updates and logout. Mock-only package checks had missed this cross-layer mismatch.

Root screenshot review found a long onboarding heading and then overlapping header/utility plus squeezed demo-banner text at320px200%. Scoped wrapping and narrow stacking fixed these without clipping, reduced font size or hidden overflow. Browser helper mistakes (initial loading capture, duplicate admin-name selector and an invalid link-level selector) were corrected before final passing receipts; they were not product successes. A standalone web-agent probe initially used the wrong browser-cache path; root's configured WSL headless browser supplied final evidence.

The first broader DB run applied036 prematurely in two historical fixture selectors that excluded only previously known future migrations. Fixes bound each intended historical baseline; production migration ordering remains strict. Another file hit `ENOMEM` while the independent APK build was consuming local memory. APK completed, the owned Gradle daemon was stopped, and the affected DB file was rerun without concurrent Android compilation. Initial full `npm test` therefore was not a pass; later component recovery is reported explicitly, not renamed as a clean initial run.

Initial Android builds were stopped when missing SDK components surfaced; the final successful build used Platform35 revision2 and CMake3.22.1 added inside the existing WSL SDK, with existing Build Tools36.0.0. No second SDK, emulator or Windows project runtime was used. Kotlin session caches are ignored, not committed.

## Remaining gates and startup

Use the [account guide](../ACCOUNTS_AND_ONBOARDING.md) for two-terminal opt-in demo commands, state ownership/restart, role meanings, real Google web/Android setup, dedicated DB capability and public Dart defines. Default account CLI makes zero requests and reports disabled. Default checked-in Worker auth is disabled; public functionality remains available.

Real Google project/consent/test users, exact web callback and server-only secret; Android package/SHA registrations and server audience/presenter; dedicated hosted auth LOGIN membership, Hyperdrive binding, deployed Secure cookies, Neon behavior and free-tier CPU/concurrency remain unverified. No provider/hosted changes were made. Android device/TalkBack, release signing/store delivery and real-user usability remain separate checks. Local mocked secure storage and debug compilation do not prove these.

Account deletion/export and cross-device interest sync are not implemented. Android offline logout clears the local token but cannot promise server revocation until confirmed; expiry still applies. Native map parity remains deferred. Incident publication, source approval, correction/retraction, real-source/model-transfer rights, human-reviewed evaluation and source-freshness runtime gates remain unchanged. AUTH-01 local delivery does not mark full MOD-01 or the production pipeline complete.
