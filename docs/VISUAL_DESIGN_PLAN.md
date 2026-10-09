# Waspada Jakarta — Visual Design and Motion Plan

**Status:** Proposed; documentation and concept artwork only.

**Prepared:** 9 October 2026 · Team 12

Companion to the [future experience roadmap](FUTURE_EXPERIENCE_ROADMAP.md). This plan gives the next design pass a concrete visual direction, front-page composition and motion specification. It changes no current UI, API, dependency or deployment. The user's request for a more eye-catching front page guides this future direction; accepted UI-00 work remains unchanged.

The requested decorative entrance is a proposed landing-only exception to UI-00's quiet-motion guidance. It does not relax that baseline for the current implementation or operational discovery/evidence screens.

## 1. Direction: Jakarta field atlas, in motion

Make the opening memorable through **a layered illustration of Jakarta, confident typography and a short unfolding sequence**. Draw from the city's river bends, elevated transport structures and Monas silhouette. Use original vector artwork rather than stock skyline photographs or generic AI imagery.

The front page can be expressive; discovery and evidence screens remain composed for reading under time pressure. Carry the same palette, type and spatial rhythm across both. The signature artwork is explicitly an illustration, not a navigable map or a representation of current incidents.

The visual hook is a light city scene on a strong ink-coloured stage. A river ribbon reveals across it, then the transport structure and skyline settle into alignment. The completed scene remains still. Below it, users can explore **Laporan → Bukti → Konteks** through ordinary buttons and readable explanatory text. This explains how to read information, not an autonomous verification demonstration.

See the [desktop/mobile concept sheet](diagrams/frontpage-design-concept.svg). It is a static planning sketch; its controls and annotations are not an implemented interface.

## 2. Tokens and layout

Retain the established six-colour identity; use placement and scale to make it stronger rather than adding unrelated accents.

| Token | Value | Future use |
| --- | --- | --- |
| Hujan Pagi | `#F4F7F5` | Main canvas and quiet reading surfaces |
| Tinta Kota | `#18323A` | Headlines, text, structural lines and one strong brand panel |
| Kali Teal | `#087B75` | Primary browse action, links and illustration's river ribbon |
| Beton | `#D5DEDB` | Dividers, inactive boundaries and illustration planes |
| Kuning Perhatian | `#E7B448` | Labelled caution and a small Monas artwork accent, spatially separate from report badges |
| Merah Tanda | `#A7433B` | Existing labelled urgent/disputed information; not decorative alert lighting |

Existing supporting surfaces remain White `#FFFFFF` and Soft Panel `#EAF0ED`; these are neutrals, not additional semantic status colours. Preserve existing status semantics: colour never replaces lifecycle, freshness, evidence or relevance labels. New colour combinations need contrast checks; established values alone do not guarantee an accessible new composition.

**Typography:** keep the current Plus Jakarta Sans / system-sans stack, without new remote font requests. Use an available local font only; no new font package is proposed. Landing display: 48–64 px desktop and 32–40 px mobile, weight 650–750. Section headings: 24–32 px. Body: 16–18 px, line height 1.5–1.65. Supporting copy: at least 14 px. Preserve tabular time numerals. Keep the whole headline one treatment rather than colouring a single arbitrary word.

**Layout:** use the existing 4 px spacing rhythm with 8/12/16/24/32/48/64 px steps. Desktop content max-width about 1200 px, two hero columns at roughly 45:55, left-aligned copy and a generous illustrated side. Mobile stacks purpose, data mode and actions before artwork. Use restrained 8–12 px corners for controls/panels, fine rules for lists, and no repeated oversized-card grid. A single soft, static shadow may separate hero planes; no moving blur or glass overlay.

## 3. Front-page composition

| Position | Content and purpose | Treatment |
| --- | --- | --- |
| Header | Waspada Jakarta; Jelajah, Pembaruan, Tentang data | Compact brand lock-up, skip link, direct public navigation; no login gate |
| Mode strip | API-confirmed demo/live/unavailable context | Full readable statement before incident content, never hidden in artwork |
| Hero copy | **“Pahami Jakarta sebelum melangkah.”** | Large sentence-case heading, short supporting text, immediately visible |
| Supporting copy | “Baca laporan, waktu kejadian, dan bukti untuk memahami dampak pada aktivitasmu.” | Two or three lines; no emergency-response or safety guarantee |
| Hero actions | **Jelajahi laporan**; **Atur minat (opsional)** | One prominent teal action, quiet secondary link; both usable during motion |
| Hero artwork | Abstract river, flyover and skyline | One authored SVG, visibly captioned **“Ilustrasi Jakarta — bukan peta kejadian”** |
| Reading demonstration | Laporan / Bukti / Konteks | User-selected explanatory panels; labelled **“Contoh cara membaca — bukan laporan aktual”** |
| Public report preview | Small list with real permitted fields, if context/data are confirmed | Event time, freshness and attribution remain separate; otherwise show the appropriate empty/unavailable state |
| Coverage and footer | Limits, sources, privacy, accessibility help | Concise factual text and normal links, including “Tidak ada laporan bukan berarti wilayah aman.” |

Keep educational panels separate from actual reports. They have no fabricated publisher, event, observation time or verification badge. A hero illustration may remain visible when API context fails because it contains no incident data; incident previews remain suppressed until dataset context is known.

```text
Desktop
┌ Brand ───────────── Jelajah · Pembaruan · Tentang data ┐
│ Visible data-mode statement                            │
│ Pahami Jakarta              Layered Jakarta artwork    │
│ sebelum melangkah.          river / flyover / Monas     │
│ Purpose + scope             illustrative caption       │
│ [Jelajahi laporan]  Atur minat (opsional)               │
├ Contoh cara membaca: [Laporan] [Bukti] [Konteks] ───────┤
│ Selected explanation, always readable as text           │
├ Confirmed public preview, or honest unavailable state ─┤
│ Coverage / privacy / accessibility                      │
└────────────────────────────────────────────────────────┘

Mobile
┌ Brand · Menu ────────────────┐
│ Visible mode statement       │
│ Headline / purpose           │
│ [Jelajahi laporan]           │
│ Atur minat (opsional)        │
│ Compact artwork + caption    │
│ Reading buttons + explanation│
│ List preview / recovery      │
│ Coverage / privacy / help    │
└──────────────────────────────┘
```

The mobile artwork takes a compact region after the actions, not a full-screen splash. Direct public event links bypass the landing, and returning visitors need not watch an introduction to reach discovery.

## 4. Effects and animation specification

These are proposed timing/size limits, not measured results. Use the existing CSS/SVG approach, without an animation library, WebGL, video background or third-party asset request. The static final state is the base styling; motion is an optional enhancement only when permitted.

| Effect | Trigger and behaviour | Limit / fallback |
| --- | --- | --- |
| **City unfolds** | Once when the landing mounts: 0–350 ms river reveal using a translated SVG mask; transport/skyline begin at 250 ms and settle by 950 ms; by 1200 ms the full composition is still | Plane translation ≤8 CSS px; stagger ≤100 ms within the transport/skyline group, not between stages. Mask stays within the fixed frame. No full-scene pan or replay on polling/filtering/rerenders. Reduced-motion or unsupported masking: complete static final scene |
| **Evidence layers** | Selecting Laporan/Bukti/Konteks updates the explanation; its decorative strip slides into place | 160–200 ms, ≤4 px translation; readable content available immediately. Native buttons with visible selection and normal keyboard/touch activation; no hover-only action |
| **Browse action feedback** | Hover/focus/press produces a clear outline/fill change; press may move the button slightly | ≤140 ms; press displacement ≤1 px, removed in reduced-motion mode. Focus indicator independent of animation; no magnetic pointer-following button |
| **Feed selection** | A user's selection highlights the item and any already-supported map feature | Static selection outline, no decorative transition. No bouncing/pulsing pins or automatic map flight |
| **Evidence disclosure** | Opening a source/history section reveals content and makes its expanded state clear | Immediate static disclosure with labelled expanded state; no fade or animated height measurement |

Use explicit `transform`/`opacity` properties for moving artwork, including the mask; simple control colour transitions are acceptable. The mask reveal needs profiling and must be simplified if it repaints excessively; no compositor performance is assumed. Do not use `transition: all`. Motion must be interruptible, must not seize focus and must never indicate new incidents or source activity. Avoid autoplay loops, flashing, danger ripples, parallax, scroll hijacking, spinning AI marks and page-wide transitions. No report status or timestamp changes for the sake of an effect.

Under `prefers-reduced-motion: reduce`, render the final artwork immediately and replace all nonessential movement with static feedback; keep content fully visible. Do not merely shorten animations that leave elements transparent. Existing smooth scrolling must also be disabled in this mode when the future change is implemented. Mobile gets the same static content and at most the bounded entrance; no extra gesture or sensor effect.

## 5. Improve the rest of the application

| Surface | Planned improvement | Connection to roadmap |
| --- | --- | --- |
| Discovery | Stronger list typography, aligned time/source rows, compact filters, clear list/map switch and selected-item outline | EXP-05/06/07; useful without the map |
| Event detail | Clear event header and four distinct information groups; compact source strip, readable evidence excerpts, reviewed-history timeline | EXP-06; retain exact time meanings and disclosure rules |
| Onboarding/interests | Short optional help panel and orderly selection groups; visible saved/unsaved states, normal controls | EXP-02/03/04; no permission prompt or animation gate |
| Update centre | A chronological reading list with reviewed-change labels, match explanation and last-successful-check time | EXP-08; no new badge counters or background monitoring claims |
| Error/loading states | Stable reserved space, static loading placeholders, explicit next actions and section-level failures | EXP-07; no shimmer loop, all-clear illustration or invented fallback data |
| Read-only evidence review | Denser evidence-comparison rows, aligned provenance/time and clearly marked read-only controls | Existing demo scope; no review mutation or new authentication |

Use common button, field, badge, spacing and focus treatments across screens. Do not apply the expressive hero scene to every view; the reports themselves provide the content and hierarchy there.

## 6. Prioritized design packages and acceptance

These packages supplement the experience roadmap; they are not active backlog assignments. Suggested roles describe responsibility rather than assigning new work to named team members.

### DGN-01 · Shared visual foundation · P0

**As a visitor, I want consistent readable controls and information hierarchy, so that I can understand the service across screens.**

1. Record tokens, type scale, component states and desktop/mobile layouts; label lifecycle, freshness, evidence and relevance separately.
2. Check new text/control colour pairs, keyboard focus, 320 CSS-pixel reflow and 200% text resizing separately; controls target 44 × 44 CSS px. Preserve the roadmap's WCAG 2.2 AA target.
3. Fixtures, unavailable sources and public withdrawal hiding retain existing meanings. No added font, analytics, account requirement or contract change.

**Output/owner:** token and component design sheet; frontend with accessibility review. Prerequisite for the following visual packages.

### DGN-02 · Memorable landing · P0, after foundation

**As a new visitor, I want a distinctive Jakarta introduction and an immediate browsing action, so that I understand the product and can start using it.**

1. Implement the approved desktop/mobile composition only after a scoped assignment exists. Purpose, mode, CTA and illustration caption are readable before, during and after artwork animation.
2. The city entrance meets the motion table, reduced-motion fallback and no-replay rules; image load, slow API and script failure never gate the browse action.
3. Reading panels are clearly instructional and keyboard/touch usable. No illustrative geometry, fabricated source or educational text becomes a public incident.
4. Record the incremental compressed transfer for art, markup and CSS against the same production-build baseline: proposed maximum **20 KiB gzip**, zero added animation-runtime JavaScript and zero third-party requests. Reserve artwork dimensions and resolve any hero-induced layout shift. This is a budget to test, not a current performance claim.

**Output/owner:** landing prototype plus static/reduced-motion variants; frontend/visual design with trust review. Implements the visual portion of EXP-01; does not activate PWA/push.

### DGN-03 · Public screen polish · P1, after foundations

**As someone investigating a report, I want clear evidence and update layouts, so that visual styling helps me scan and compare information.**

1. Review discovery, detail, local interests and updates at desktop/mobile sizes; maintain source/time/status separation and accessible list parity.
2. Every new hover effect has equivalent focus/selected behaviour; no action depends on animation, dragging or colour alone.
3. Loading, empty, 404, 429, cursor-restart, source/map failure and offline states follow EXP-07. History and updates still hide withdrawn publications; freshness-only changes do not become update entries.

**Output/owner:** screen/state design sheets, then separately scoped implementation slices; frontend with backend contract review.

### DGN-04 · Visual and motion validation · Release gate

**As a visitor on a modest phone or using assistive technology, I want the design to stay responsive and understandable, so that decoration does not delay or obstruct my task.**

1. Inspect future implementation screenshots at 1440 px, 768 px, 390 px and 320 px widths, including long Bahasa Indonesia copy and errors. Inspect animation start/midpoint/final states and reduced-motion/unsupported-animation fallback.
2. Test focus/activation during the sequence, keyboard navigation, zoom/reflow and no API-dependent CTA. Record an actual browser/screen-reader pairing, including Android browser/TalkBack for that target. Hide decorative hero internals from assistive technology or expose one concise image name, with the visible caption separate. Use the roadmap's shared 6–8 participant study; preserve its discovery/time/evidence target and record artwork/motion confusion.
3. Measure the same build with and without the hero enhancement; record actual asset delta, layout stability and observed low-end Android responsiveness. If budget or core-task usability fails, simplify the art/motion before release.
4. Run the scoped project's checks in WSL Ubuntu-26.04 when implemented. Keep desktop/mobile screenshot, target-device and screen-reader evidence separate from automated test results.

**Output/owner:** concise design critique, measured comparison and accessibility findings; reviewer/QA. These are future checks, not results of this documentation task.

## 7. Review and references

Before implementation, review the concept against the four user questions in the experience roadmap. It should read as Jakarta civic information with a memorable opening, retain public browsing without accounts, and have a complete static experience. Refine the artwork and copy before adding further effects.

Design guidance and motion documentation are retained in the local [reference register](../REFERENCES.md#visual-design-and-motion-plan--reviewed-9-october-2026). The composition, durations and budgets are project choices. No code review, device performance or WCAG conformance is claimed by this plan.
