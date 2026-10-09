# UX-DESIGN-FLUTTER-01 — public experience implementation wave

**Status:** Assigned, 9 October 2026. Root integrates and reviews; implementers use GPT-6 Luna with max reasoning, isolated branches/worktrees, and committed handoffs.

**Authorization:** Team 12 asked to implement the UX/design roadmap and mobile port in parallel, then explicitly selected Flutter/Dart for mobile. This activates the local slices below and supersedes the earlier documentation-only boundary for them. Account-free public browsing, existing public API contracts, labelled demo data, evidence/withdrawal rules and free-tier deployment target remain unchanged. No hosted deployment, source activation, push service, account, billing or native-store release is part of this wave.

## Parallel slices and ownership

| ID | Branch | Owned paths | Deliverable |
| --- | --- | --- | --- |
| UI-LANDING-01 | `work/UI-LANDING-01` | `apps/web/src/Landing.tsx`, `apps/web/src/HeroIllustration.tsx`, `apps/web/src/landing.css`, `apps/web/test/landing.test.tsx`, own handoff | Jakarta landing with bounded city motion, explicit browse action, labelled instructional panels, context-gated public preview |
| UI-EXPERIENCE-01 | `work/UI-EXPERIENCE-01` | `apps/web/src/PrivacyPage.tsx`, `apps/web/src/ReadGuide.tsx`, `apps/web/src/privacy-store.ts`, `apps/web/src/experience.css`, `apps/web/test/experience.test.tsx`, own handoff | Optional readable guide and local privacy controls, truthful partial reset, keyboard/touch/zoom layout |
| MOBILE-FLUTTER-01 | `work/MOBILE-FLUTTER-01` | `apps/mobile/**`, own handoff | Flutter Android public client: landing, list/filter, details/evidence/history, local preferences/privacy and explicit loading/empty/error/offline states |
| UI-PUBLIC-POLISH-01 | `work/UI-PUBLIC-POLISH-01` | `public-polish.css`, assigned public copy/focus corrections and focused tests, own handoff | Static public-screen hierarchy, consistent freshness labels, accessible focus and local-reset recovery |
| UI-HERO-02 | `work/UI-HERO-02` | `HeroIllustration.tsx`, art-only `landing.css` selectors/keyframes, optional hero test, own handoff | Complex original Jakarta SVG/motion refinement; GPT-6.1 Sol/max at user's explicit direction |
| Root integration | `codex/ux-design-flutter` | Shared web routing, entrypoint/styles, test scripts, API cache/error handling if needed, planning/status docs, review evidence | Compose web components, preserve deep links and current contracts, run WSL checks and browser visual review |

Implementers must read the SDP product scope, UX/API specification, future experience roadmap and visual design plan. They may read any required code but edit only owned paths. Shared dependencies, root lockfiles, App routing and global docs belong to root. Ask root before expanding ownership; do not overwrite another agent's work. Commit meaningful implementation and a task-specific `*-HANDOFF.md` recording actual checks, commit IDs and limitations. Do not push; root periodically pushes reviewed integration checkpoints.

## Acceptance

1. Landing implements EXP-01 and DGN-02: purpose/actions/data-mode visible throughout, original illustrative Jakarta artwork rather than incident geometry, one bounded entrance with complete static reduced-motion fallback, no animation/permission/login gate. Instructional panels create no real events or verification claims.
2. Guide/privacy implements the local slice of EXP-02/04/05: four distinct status/time meanings, skippable/reopenable help, explain local interests/cursor versus network metadata, clear only Waspada-owned local keys and invalidate related memory. Report failures per key, never false complete deletion or server deletion. No interests sent automatically.
3. Flutter uses the same public DTO meanings and exact endpoints. No account, geo/notification permission, source scrape, map geometry invention, background monitoring or incident persistence. Manual refresh is explicit; source/time/evidence remain visible and historical/demo records labelled. API origin is configuration, not an invented hosted endpoint; missing/invalid origin has a useful unavailable state. Production requests use HTTPS; local emulator development may use an explicitly scoped debug origin.
4. Mobile local interests never leave the device on edit/save. Start with public list/detail/history and local category matching; do not add briefing/subscription backends or imply full update-centre parity where not implemented. Publish a parity matrix and explicitly deferred capabilities. Flutter's API adapter and UI must support injected synthetic tests without live services.
5. All new screens are Bahasa Indonesia, usable at narrow widths, keyboard/screen-reader labelled, with non-colour status cues and useful retries. Keep read-only moderator demo unchanged. Operational screens receive static design polish; decoration belongs on landing.

## Checks and gates

- WSL Ubuntu-26.04: native Node 24.21.0 via `/home/perry/.local/opt/waspada-node-v24.21.0/bin`; locked JS dependencies only. Root can arrange a dependency symlink to the existing WSL-tested `/mnt/d/Projects/RPL/node_modules`; no dependency churn.
- Web slices: focused meaningful tests plus web typecheck/build where composable. Root runs integrated web tests, full project typecheck/build, existing smoke and desktop/mobile browser screenshots, including reduced motion and errors. Record bundle delta against base before release claims.
- Flutter: official stable Linux SDK, `flutter analyze`, injected client/widget tests and an Android debug build if local Android tooling can be prepared. No Android Studio/GUI interaction; tooling and caches remain local/ignored. SDK downloads do not activate a service. No LaTeX tooling.
- Android device/TalkBack, human usability study, hosted free-tier behaviour and live data remain separate unverified gates unless actually exercised. A compiled APK or test is not a claim of those gates passing.
- PWA/push and store release remain outside this slice; the user's Flutter decision is the mobile framework choice, not notification or deployment authorization.

## Review record

Root will fill integration commits, check results, visual findings and unresolved gates in the final handoff. Acceptance of this wave does not accept every future-roadmap story or activate live sources.
