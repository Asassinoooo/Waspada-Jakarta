# Waspada Jakarta — Future Experience Roadmap

**Status:** Roadmap with selected local implementation activated on 9 October 2026; release and remaining stories are gated.

**Prepared:** 9 October 2026 · Team 12

**Scope:** Landing, first use, privacy, accessibility, trust, recovery, updates and mobile delivery.

This roadmap extends the public experience described in the [Software Development Plan](../SOFTWARE_DEVELOPMENT_PLAN.md) and [UI/API specification](UX_API_SPEC.md). Team 12 subsequently authorized the [UX-DESIGN-FLUTTER-01 wave](assignments/UX-DESIGN-FLUTTER-01.md): landing, optional guide, local privacy controls, static screen polish and a Flutter public Android client. User stories remain acceptance targets, rather than blanket completion claims. Public API/data contracts and hosted configuration are unchanged; actual results belong in implementation handoffs.

The companion [visual design and motion plan](VISUAL_DESIGN_PLAN.md) specifies a more expressive Jakarta front page, shared design tokens and bounded animation, with a [desktop/mobile concept sheet](diagrams/frontpage-design-concept.svg). Its selected local packages are integrated on `codex/ux-design-flutter`; the [integration handoff](assignments/UX-DESIGN-FLUTTER-01-HANDOFF.md) records the actual checks and remaining gates. Flutter/Dart is the chosen Android framework under [ADR-054](decisions/ADR-054-flutter-public-client.md); PWA/push and native release remain separate gates.

## 1. Outcome and boundaries

Help residents and visitors answer four questions quickly: **What was reported? Does it affect me? How current is it? What evidence supports it?** Public discovery, event details, evidence and reviewed history remain accessible without a Waspada account. Choosing interests, completing onboarding, granting permissions or installing an app must never become a condition of browsing.

The experience remains a calm Bahasa Indonesia civic information service. It provides situational awareness, not emergency dispatch, crime prediction or guaranteed safe routes. No reports does not mean an area is safe. Existing demo and source-rights gates remain in force; historical or synthetic examples never become invented live alerts.

Current design already covers local interests, explicit transient briefing requests, an in-site update centre and evidence-led public views. Future work should improve their clarity rather than duplicate them. Event lifecycle, information freshness, claim evidence and personal relevance retain separate meanings. Moderator screens remain read-only for the course demo.

## 2. Priorities and delivery sequence

Priority indicates order of investment, not a promised delivery date. The table retains the broader sequence; the scoped local wave activates parts of EXP-01/02/04/05/06/07 and the Flutter reader foundation. It does not accept every criterion in those stories. Human studies, permission flows, PWA/push and native release remain proposed. Flutter was selected directly by the team; comparative channel evidence still needs EXP-11 research.

| Priority | Story | Reason and dependency | Evidence needed to proceed |
| --- | --- | --- | --- |
| P0 | EXP-06 Trust and evidence | Misread status or time can mislead users; foundation for every surface | Status/time comprehension and public-disclosure review |
| P0 | EXP-07 Error and coverage states | Users need to distinguish missing data from absence of incidents | State matrix exercised, including partial failure |
| P0 | EXP-04 Privacy controls | Local interests and outgoing requests need understandable boundaries | Data inventory, reset and network checks |
| P0 | EXP-05 Accessibility | Core tasks must work through the list and assistive technology | Manual keyboard, screen-reader and responsive review |
| P0 | EXP-01 Landing and direct entry | Explain the service and reach discovery immediately | First-visit and direct-link usability checks; depends on the four foundations |
| P1 | EXP-02 Optional orientation | Explain unfamiliar labels without blocking access | Skip/reopen and comprehension checks; follows EXP-01/06 |
| P1 | EXP-03 Optional interest setup | Improve relevance without requiring identity or location access | Save/failure/reset checks; follows EXP-04/05 |
| P1 | EXP-08 In-site updates | Make current update behaviour understandable before adding push | Active-view, matching and cursor-recovery checks; follows EXP-03/06/07 |
| P1 | EXP-11 Android delivery study | Recommend a channel pilot from observed needs | Responsive-web study, PWA concept and device/capability matrix; final choice follows pilot evidence |
| P2 | EXP-10 Optional PWA | Pilot easier return visits with a limited offline shell | EXP-11 recommends a PWA pilot; EXP-04/05/07 pass; actual install/update/offline checks inform final choice |
| P3 | EXP-09 Optional push | Adds subscriptions, delivery policy and privacy responsibilities | Demonstrated need, consent/data design, public-eligibility and free-tier gates |
| Authorized local slice | Flutter Android reader | Team 12 selected Flutter/Dart; separate client maintenance remains explicit | UX-DESIGN-FLUTTER-01 and ADR-054; release still needs device/usability/API-origin evidence |

For work beyond the authorized local wave, prototype with labelled synthetic content and evaluate it before promoting further stories into the active backlog. The integrated wave does not establish human-study acceptance. Installation does not automatically enable push; native Android is not a prerequisite for either public browsing or in-site updates.

## 3. User stories and acceptance criteria

The EXP identifiers supplement US-01 Discovery and US-02 Following updates; they do not replace the existing stories. Each numbered criterion has a stable reference such as `EXP-01.AC1`. Verification described here is future acceptance work, not a report of checks already completed.

### EXP-01 · Landing and direct entry · P0

**As a first-time Jakarta resident or visitor, I want to understand the service and immediately explore reports, so that I can decide whether it is useful for my situation.**

1. The first screen states the purpose, coverage limitations and dataset mode in Bahasa Indonesia. Its primary action, **“Jelajahi laporan”**, opens discovery in one action; **“Atur minat (opsional)”** is secondary.
2. Public browsing presents no sign-in, permission, installation or onboarding gate. Shared event links open the intended public detail directly, and returning visitors can resume discovery without repeating orientation.
3. Demonstration instances retain **“DEMO — data historis/sintetis; bukan peringatan langsung.”** Unknown context displays an unavailable-mode state and suppresses incident previews until the dataset is confirmed. Once confirmed, previews are visibly labelled and use only the server-selected dataset.
4. Discovery works as a readable list on mobile and without the map. The landing introduces sources, time and status meanings, with no unsupported live counters, neighbourhood safety scores or chatbot as the primary entry.

### EXP-02 · Skippable first-use orientation · P1

**As someone unfamiliar with incident information, I want a short explanation of labels and map shapes, so that I interpret reports correctly without delaying my task.**

1. A short optional help panel explains lifecycle, freshness, evidence and relevance with labelled examples. It distinguishes event time from publication/fetch time, and points from official boundaries or supported segments.
2. **“Lewati”** and **“Mulai jelajah”** both preserve the intended destination and filters. No multi-step tour is mandatory; help can be reopened from discovery and detail.
3. First load, skipping and completing orientation never request location or notification permission. Installation is offered separately only after demonstrated usefulness.
4. An orientation-dismissal marker, if retained, is local to this browser and removable through privacy controls. Storage failure does not block access or produce a claim that dismissal was saved.

### EXP-03 · Optional local interests · P1

**As someone who follows particular places or services, I want to choose and manage interests without an account, so that I can find relevant reports while controlling what I share.**

1. Users can manually select available places, services, institutions, audiences and categories, or continue with none. Precise home/work addresses, continuous location tracking and inferred group membership are not required.
2. Editing and saving retain interests locally and send no interest values to the server. A briefing request sends them only after the user explicitly selects the request action and exact live mode is confirmed; demo/unknown mode explains its limitation.
3. Setup explains **“Minat tersimpan di browser ini”**, the potentially sensitive nature of group choices, lack of cross-device sync and loss after browser-data clearing. Users can inspect, remove or reset selections.
4. Blocked/quota-limited storage produces an honest unsaved or session-only state with retry. Reload never implies lost settings are still stored. Failure to save or choosing no interests leaves general discovery available.
5. Relevant results state the matching place/service/group. A match is never presented as verification, severity or evidence that the user is physically present there.

### EXP-04 · Privacy and data controls · P0

**As a privacy-conscious visitor, I want to understand and control local data and outgoing requests, so that using public information does not require unnecessary disclosure.**

1. A reachable privacy panel lists application-owned local interests, update cursor and any future onboarding marker, separately from transient briefing requests, ordinary request metadata and provider processing. Wording is checked against an actual data inventory; it never claims that no data reaches servers.
2. **“Hapus data Waspada di browser ini”** removes only Waspada-owned local keys and any future app-owned caches, and resets related in-memory state. A failure identifies what could not be cleared; success is shown only after successful removal. Unrelated browser/site data is untouched.
3. Local reset does not claim to delete source records, server/provider logs or a future push subscription. Any future subscription has a separate unsubscribe/server-deletion flow and documented retention rules before launch.
4. No interest values enter automatic update polling, analytics, URLs or diagnostic logs. Any future tracking or additional transmission requires its own documented purpose and consent decision; this roadmap adds none.
5. Privacy controls and help remain account-free and usable when personalization is disabled. Read-only demo moderation and existing source-retention/rights policies remain unchanged.

### EXP-05 · Accessible core tasks · P0

**As a visitor using assistive technology or a small screen, I want to browse and understand reports through accessible controls and text, so that I have the same useful information as other users.**

1. Future changes target **WCAG 2.2 AA**, without claiming current conformance. Keyboard and screen-reader checks cover landing, discovery/filtering, detail/evidence, interests, updates, help and privacy reset.
2. Every action has an accessible name and visible focus. Overlays support logical focus order, Escape where appropriate and focus return; sticky UI does not obscure focused controls. Statuses use text and meaningful symbols in addition to colour.
3. Text contrast meets 4.5:1, or 3:1 for qualifying large text; relevant controls/graphics meet 3:1. The product targets 44 × 44 CSS-pixel touch controls, distinct from WCAG's minimum target-size requirement.
4. Check reflow at 320 CSS pixels and text resizing to 200% separately, preserving core content and controls. Core flows avoid required horizontal scrolling. Spatial information also has a text/list equivalent; map interaction never blocks the task.
5. Loading, result counts and failures have useful screen-reader announcements without repeating on every poll. Reduced-motion preferences are respected. Automated findings plus manual keyboard and Android TalkBack results are recorded before acceptance.

### EXP-06 · Trustworthy reports and history · P0

**As someone assessing a report, I want to see its evidence, time, uncertainty and reviewed changes, so that I can judge what it supports before acting.**

1. List, detail and future installed views keep lifecycle, freshness, evidence labels and relevance distinct. Claim freshness remains grouped under event freshness; individual impacts retain their existing freshness fields. No new public claim field is implied.
2. Detail shows approved attribution/source links and separates event/observation time, source publication, system fetch and issuer validity when available. Unknown, date-only or ranged times retain their precision and render consistently in WIB.
3. Maps show only supported points, source-defined boundaries or documented segments. Historical crime reports never appear as present danger zones; unmapped service/group notices remain discoverable through the list.
4. History exposes only currently permitted versions with moderator-reviewed labels and summaries. Withdrawn versions, and all history/update entries after latest-event withdrawal, remain hidden; the UI does not invent a public withdrawal explanation or tombstone.
5. Follow the accepted deadline/aggregate rules in [ADR-032](decisions/ADR-032-review-deadline-freshness.md): a review deadline alone means `needs_update`; ended explicit issuer validity takes precedence as `expired`, regardless of older UI wording. Under [ADR-048](decisions/ADR-048-source-report-withdrawn-freshness.md), explicit source-report retraction/supersession/withdrawal affects exact current live publications directly supported by that revision: event and affected-impact freshness becomes `needs_update`, subject to issuer-validity precedence, while the published version awaits review. Source-report withdrawal is distinct from event-publication withdrawal in AC4. Fetch failure establishes neither; no freshness state implies resolution or safety.
6. Plain help explains AI-assisted processing and deterministic publication rules, with human review of disputed information. Model confidence never becomes a “verified” badge, and demonstration content never claims real moderator approval.

### EXP-07 · Recovery and coverage honesty · P0

**As a visitor encountering incomplete data or a failure, I want to understand the limitation and recover, so that I do not mistake missing information for safe conditions.**

1. Each state below has a distinct message and action. Loading never flashes a no-results assertion; empty results never assert safety. Any retained response keeps its original timestamps and an outdated/unavailable indicator instead of being relabelled current.
2. Retry preserves selected filters and local interests. Failure never silently substitutes synthetic content into a live view, resets event lifecycle or marks an event resolved.
3. Detail/history/source failures are scoped: available permitted sections remain readable, with the failed section identified. A map failure leaves list discovery functional and does not invent geometry.
4. Rate limits honour `Retry-After` when provided; otherwise there is no invented retry countdown. Cursor recovery follows the existing baseline-then-snapshot sequence, with deduplication and an explanation that older summaries are unavailable.
5. Messages expose no private moderation reasons, evidence payloads, credentials or internal traces. Keyboard and screen-reader users can reach the explanation and recovery action.

| State | Example Bahasa Indonesia message | Recovery / interpretation |
| --- | --- | --- |
| Loading | “Memuat laporan…” | Keep controls usable; announce completion |
| Successful empty filter result | “Tidak ada laporan yang cocok dengan filter ini. Ini tidak berarti wilayah aman.” | Clear/change filters |
| Unknown dataset context | “Mode data belum dapat dikonfirmasi.” | Retry context; no live assertion |
| Source unavailable / partial coverage | “Sebagian sumber belum tersedia; cakupan laporan mungkin terbatas.” | Show known availability/check time; separate source failure from report status |
| Network/5xx or offline | “Data terbaru belum dapat dimuat.” | Retry; distinguish latest failed attempt from last successful check |
| Map unavailable | “Peta belum tersedia. Laporan tetap dapat dibaca dalam daftar.” | Use list; retry map |
| Public detail 404 | “Laporan tidak tersedia untuk ditampilkan.” | Return to discovery; no disclosure of hidden status/reasons |
| Rate limited / 429 | “Terlalu banyak permintaan. Coba lagi nanti.” | Respect supplied retry timing |
| Update cursor expired / 410 | “Ringkasan pembaruan lama tidak tersedia. Memuat kondisi saat ini…” | Clear cursor/items, establish baseline, refresh current snapshot, resume |
| Local storage unavailable | “Pilihan belum tersimpan di browser ini.” | Retry or continue without persisted preferences |

### EXP-08 · Understandable in-site updates · P1

**As someone following local interests, I want to know what changed and when updates were checked, so that I can revisit relevant reports without duplicate or misleading alerts.**

1. The update centre explains that automatic checking works only while that view is active and visible. Manual refresh and the last successful check time are visible; background/hidden views do not suggest continuous monitoring.
2. First use establishes a baseline without replaying older changes. Polling retains the current 60-second interval, page size 20 and bounded detail lookup behaviour; UI improvements do not expand that contract.
3. Matching uses local interests against current public detail without transmitting those interests during polling. Update items show why they match and open the current public event. Unavailable or withdrawn current detail suppresses the item.
4. Labels/summaries come from moderator-reviewed published-version changes. Version-publication time stays separate from event time; repeated event/version pairs produce one item. Freshness-only transitions remain on event views and create no standalone update entries.
5. Cursor persistence remains local and opaque; update-item history is not persisted. Empty, stale, storage-failure and cursor-restart states follow EXP-07, with no claim of guaranteed alert delivery or safety.

### EXP-09 · Optional push notifications · P3, conditional

**As someone who explicitly wants reminders beyond the open website, I want controllable notifications without a Waspada account, so that I can return to relevant published updates on my terms.**

1. An explanation precedes a user-selected **“Aktifkan notifikasi”** action. Web notification permission is requested only from that action in a supported secure context. A future native client handles Android's separate runtime-permission rules. Denial, dismissal, revocation or lack of support preserves browsing and in-site updates, without repeated unsolicited prompts.
2. Before enrolment, explain subscription endpoint/device metadata, what selection data would leave the browser, processing parties and retention/deletion. Existing local interests never silently become server-stored subscription filters. A reviewed consent and storage design is a prerequisite.
3. Settings expose pause, unsubscribe, frequency cap and quiet hours in WIB. Default lock-screen content is neutral and omits saved places/group interests, private information and unreviewed allegations. The precise cap, digest policy and expiry budget must be decided and tested before launch.
4. A future dispatcher rechecks current public eligibility and issuer validity before sending, deduplicates event/version deliveries and drops superseded or no-longer-public queued content. Opening a notification re-fetches current public detail; missing detail yields the neutral unavailable state.
5. The UI explains that delivery can be delayed or absent and already delivered content cannot be reliably recalled. Notification time is distinct from event/publication time; push never becomes emergency-response assurance.
6. Account-free device-level revocation/deletion is tested without exposing other subscriptions. Subscription storage, authorization, matching, retries and delivery require a separate backend/privacy design: the existing public `/updates` contract alone does not provide them. Demonstrated user need and verified free-tier fit are mandatory; no paid fallback is automatic.

### EXP-10 · Optional PWA installation and offline shell · P2

**As a returning mobile visitor, I want an optional home-screen entry and clear offline behaviour, so that I can return quickly without confusing old information with current reports.**

1. Offer installation contextually after useful browsing, with platform-appropriate instructions only when supported. Declining or lacking install support leaves the complete public website usable and account-free.
2. A future manifest/service-worker implementation is a separately assigned task. Its initial cache scope is versioned UI/help assets only; persistent incident, evidence, history, briefing and update API caches are excluded. Before acceptance, define and verify request/response and intermediary-cache policies preventing offline reuse of public data; do not assume a service-worker rule controls every cache.
3. Offline launch shows the static shell/help and **“Offline — data kejadian saat ini tidak tersedia.”** After a successful online event read, an offline repeat must not render that response from browser, service-worker or app storage. Reconnection retrieves current public data before presenting it; withdrawal/freshness cannot be revalidated offline.
4. Installed navigation preserves public deep links, accessible list/detail views and understandable back navigation. Version updates do not erase valid local interests or mix incompatible cached asset versions; failed update/clearing is recoverable.
5. Android-device checks cover installation, refusal, browser opening, offline/reconnect and application updates. Explain that uninstalling or browser storage eviction can affect local data; do not promise sync or retention. Push remains separately gated under EXP-09.

### EXP-11 · PWA versus native Android decision · P1 study

**Decision update:** Flutter/Dart has been selected by Team 12 for the local Android reader under ADR-054. The criteria below still govern comparative channel research and any release expansion; they are not retroactive claims that such a study has passed. PWA work is not activated by the Flutter implementation.

**As a frequent Android visitor, I want the most dependable way to return to public reports, so that I get useful access without unnecessary setup or a second inconsistent experience.**

1. Compare responsive web, the authorized local Flutter reader and a non-installing PWA concept with 6–8 residents/visitors, including assistive-technology and constrained-connectivity tasks. Reuse the core-usability cohort with explicit task coverage; use labelled synthetic examples and report counts/limitations. Further client capabilities require their own scoped implementation assignment.
2. Record Android/browser versions, test date and physical devices, separating observed browser capabilities from unbuilt Waspada features. Study shared links, return visits and permission/offline needs now; actual Waspada installation, updates and offline checks follow conditional EXP-10. No universal support or guaranteed background delivery is assumed.
3. The decision records core-task completion, return-visit friction, an evidenced need for background notifications or device integration, accessibility, privacy, maintenance and distribution costs. A current notification permission gate is considered for native Android, not bypassed by choosing native.
4. P1 recommends whether to run the EXP-10 PWA pilot alongside the selected Flutter reader; it does not establish release readiness from a concept or debug build alone. Responsive web remains the foundation. Evidence from the study, any actual pilot and independently established platform limits informs expansion or a revisit of the Flutter decision. Android delivery additionally needs an owner for releases, security, accessibility and distribution. Record alternatives and the revisit trigger.
5. Every option retains public web access and no Waspada login requirement for browsing or installation. If an option needs spending, provider configuration or expanded data processing, prepare the concrete proposal for the relevant decision first; do not activate it from this roadmap.

## 4. Platform decision canvas

| Option | User benefit | Trade-off to validate | Proposed disposition |
| --- | --- | --- | --- |
| Responsive public web | Direct shared links, immediate browsing | Return visits need browser/bookmark navigation; no promised background monitoring | Foundation for all priorities |
| PWA | Optional home-screen entry and static offline help using the web experience | Install behaviour varies by platform; caches and updates add failure/privacy work; background delivery needs a separate design | Evaluate at P1; implement at P2 only if useful |
| Flutter Android | Dedicated account-free public reader, chosen by Team 12 | Separate client testing, distribution and release maintenance; no guaranteed timely alerts | Local reader assigned under ADR-054; production release and research remain gated |

PWA-first is a project recommendation, not an accepted architecture change. Initial offline support intentionally excludes incident data. Neither PWA nor native removes source-rights, publication review, freshness, privacy or free-tier constraints. No external service, app-store listing or paid account is created by this plan.

## 5. Validation and promotion gates

| Gate | Future evidence and acceptance rule | Suggested responsibility |
| --- | --- | --- |
| Task usability | Retain the existing target: at least 80% of a 6–8 participant study reach discovery, find an applicable report and read time/evidence within one minute. Check direct links open the intended public detail without an account/onboarding gate. Record purpose comprehension, counts and failures; revise unsafe interpretations rather than claim population-wide success. | UX/frontend |
| Trust comprehension | Participants distinguish event status, freshness, evidence and relevance; any observed “no reports = safe”, historical crime = current zone, or expiry = resolved interpretation triggers revision before promotion. | UX + evidence reviewer |
| Privacy | Inventory matches actual storage/network behaviour; edit/save/poll sends no interest values; explicit briefing and reset success/failure are exercised. No registration required on any public journey. | Backend/privacy reviewer |
| Accessibility | Record automated checks plus manual keyboard, TalkBack, zoom/reflow, contrast, focus and status-announcement results against EXP-05; resolve blocking core-task failures. | QA + frontend |
| Failure recovery | Exercise every EXP-07 row, including map-only failure, mixed section failure, cursor reset and unavailable storage; preserve disclosure and dataset boundaries. | QA/backend |
| Platform / push | On physical target Android devices, check supported/unsupported/denied/install/offline/update paths. Push additionally needs consent, revocation, queued-withdrawal, duplicate/expiry and budget evidence. | Platform + privacy reviewer |

Use voluntary study participation and minimal notes; avoid collecting precise addresses or sensitive interest selections unnecessarily. This roadmap introduces no analytics SDK or telemetry collection. Implementation checks will run in WSL Ubuntu-26.04 where applicable; Android and assistive-technology acceptance needs actual target-device evidence. Passing local tests alone does not prove deployed behaviour.

## 6. Decisions still open

These questions do not block P0 planning. Resolve them at the listed gate rather than interrupting browsing or activating a future channel early.

| Decision | When to resolve | Required input |
| --- | --- | --- |
| Exact landing/help wording and default entry behaviour | Before EXP-01/02 assignment acceptance | Bahasa Indonesia comprehension and direct-link prototype results |
| Supported Android/browser/device matrix | During EXP-11 | Participants' devices and recorded capability/accessibility tests |
| Whether push solves a real unmet need | Before EXP-09 promotion | In-site update study and user demand; distinguish convenience from emergency expectations |
| Subscription matching, minimum retained data, retention/deletion, delivery TTL, caps and quiet hours | Before push implementation | Privacy/security design, public-eligibility rules and consent prototype |
| Free-tier operating envelope for extra delivery work | Before any channel activation | Dated provider limits and representative measurements; no paid fallback |
| Native-only requirement, release owner and distribution path | Only if EXP-11 identifies a gap | Evidence, maintenance commitment and cost/service decision |

The [source-clearance plan](SOURCE_CLEARANCE_PLAN.md), human-reviewed evaluation and hosted compatibility gates continue to govern live use. Research may use synthetic prototypes while those gates remain pending.

## 7. References and change control

Official accessibility/platform sources and their review dates are recorded in the local [reference register](../REFERENCES.md#future-experience-roadmap--reviewed-9-october-2026). The priorities, account-free approach, cache restrictions and acceptance gates are Waspada design decisions, not claims that external documentation mandates this exact architecture. Recheck platform behaviour and terms before implementation.

Promoting a story requires a scoped backlog assignment listing allowed paths, dependencies, contract impact and checks. Any later contract or architectural change needs its corresponding specification/decision update; this roadmap does not silently revise existing contracts. Its completion means the plan is documented, not that any experience story has passed acceptance.
