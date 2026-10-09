# ADR-054 — Flutter public Android client

**Status:** Accepted framework and local implementation scope; release gates remain open.

**Date / owner:** 9 October 2026 · Team 12.

## Context and decision

Team 12 authorized implementation of the experience/design roadmap and explicitly chose Flutter/Dart for Android. Build a separate Flutter client in `apps/mobile`, consuming the existing public HTTP projections. React remains the web client. This decision supersedes the roadmap's deferred framework selection for this local slice; it does not establish that a native client outperforms a PWA in a usability study.

Flutter belongs to Layer 4 application integration. Ingestion, knowledge storage, model grounding, bounded investigation, deterministic publication and monitoring retain their existing five-layer responsibilities. Neither client performs autonomous publication or runs a local LLM. Public browsing remains account-free.

## Technical decisions and trade-offs

1. **Separate Dart UI, shared HTTP contract.** Flutter gives Android a purpose-built client and accessible Material controls. React components cannot be reused directly, so parity, contract validation and maintenance need explicit checks. Kotlin/Compose and Capacitor were alternatives; the user's Flutter choice resolves the framework decision.
2. **HTTPS API origin supplied at build/run time.** The app does not invent a hosted endpoint or embed credentials. Missing configuration has a usable unavailable state. A debug-only loopback/emulator exception supports local development; release requires HTTPS. This avoids changing cloud services but requires the builder to choose a working origin.
3. **Small public-reader slice with local preferences.** Start with context, paged list/filter, details/evidence/history, guide and verified local reset. Public responses remain in memory. Maps, briefing requests, update polling, push, subscriptions, background work, offline incident caching and moderation stay deferred. This reduces implementation risk; it also means the first app has less functionality than the web client.

## Validation and release boundary

Use WSL Ubuntu-26.04 for Dart analysis, injected HTTP/widget tests and Android builds. Root reviews contract identity, source/time/status semantics, request races, local storage and narrow/large-text layouts. A web build is an auxiliary Flutter preview, not the production web replacement. A debug APK is not evidence of physical-device/TalkBack usability, release signing, Play Store acceptance, live-source quality or hosted free-tier performance.

The existing Cloudflare/Neon Free target and source-rights gates remain unchanged. No backend subscription or additional hosted resource is introduced. See the [implementation assignment](../assignments/UX-DESIGN-FLUTTER-01.md), [mobile setup/parity guide](../../apps/mobile/README.md) and eventual integration handoff for actual results.
