# UI-V2 design principles

Status: UI-V2-A (app shell, simplified navigation, UI primitives, first-visit intro). Phases B to D are planned in `docs/IMPLEMENTATION_BACKLOG.md`. Tokens and primitives extend UI-SYSTEM-01 and UI-SYSTEM-02 and keep their rules.

## Principles

- One primary action per screen (`.button--primary`). Other actions are quiet (`.button--quiet`) or danger-styled only when they remove or reject something.
- Honesty first. Waspada Jakarta shows what was reported, from which source, how fresh it is and how relevant it is. It never says an area is safe, and it is not an emergency service. The emergency line 112 appears in the footer and the first-visit intro.
- Dataset mode is always visible as one badge. Demo data is never labelled as live.
- Three destinations in the primary navigation: Peta, Pembaruan, Area saya. Help, privacy and the admin workspace sit in the account menu or the footer.
- Admin and review destinations never appear as public links. The account menu shows them only to moderator and admin roles. Routes still enforce the role on the server and in the client gate.

## Route map (phase A)

| Hash | Screen | Notes |
| --- | --- | --- |
| `#peta`, empty hash, `#beranda`, `#jelajah`, `#laporan-publik*`, `#publik-demo`, unknown | discover (map home, UI-V2-B) | Home. The map fills the screen. `#peta?event=<id>` and `#jelajah?event=<id>` select one published event. Unknown hashes fall through here. |
| `#pembaruan` | updates | Primary nav. |
| `#ringkasan-saya` | preferences ("Area saya") | Primary nav. |
| `#akun`, `#masuk`, `#mulai` | account screens | Opened from the account menu. |
| `#bantuan`, `#panduan`, `#privasi` | help and privacy | Footer and account menu. "Lihat pengenalan lagi" reopens the intro. |
| `#detail/...` | event detail | Unchanged. |
| `#admin/ringkasan`, `#admin/akun`, `#admin`, `#admin-workspace` | administrator workspace | Admin role. |
| `#admin/tinjau`, `#tinjau-bukti` | review | Moderator or admin role. |
| `#admin/alur`, `#alur-agen` | pipeline flow | Moderator or admin role. |
| `#admin/embedding`, `#visualisasi-3d`, `#embedding-3d` | 3D embedding view | Linked from the admin menu. |
| `#admin/sumber`, `#demo-sumber` | source preview | Admin role only. |

Phase C turns `#admin/<tab>` into real tabs. Until then each tab opens its existing screen.

## Primitives

Source in `apps/web/src/ui/`. Styles in `apps/web/src/design/components.css`. Keyboard helpers in `ui/a11y.ts` are pure and unit-tested.

| Primitive | Classes | Behaviour |
| --- | --- | --- |
| Dialog | `.modal-overlay.ui-overlay` > `.modal-dialog.ui-dialog` | `aria-modal`, named by its heading. Focus moves in, Tab cycles inside, Escape closes, focus returns to the opener. |
| Sheet | `.sheet-overlay--left` or `--right` > `.sheet` | Rises from the bottom below 900px. Side panel from 900px. Same semantics as Dialog. |
| Tabs | `.tabs`, `.tabs__tab`, `.tabs__panel` | Roving tabindex. ArrowLeft and ArrowRight wrap, Home and End jump. |
| Menu | `.menu`, `.menu__trigger`, `.menu__list--start` or `--end`, `.menu__item` | `aria-haspopup`, `role="menu"`. Arrow keys, Escape and outside press close it. |
| Popover | `.popover`, `.popover__trigger`, `.popover__panel` | Anchored disclosure. Content stays in the markup and is hidden until opened. |
| Layout | `.toolbar`, `.empty-state` (+ `__title`), `.skeleton` | Wrapping row, centred empty message, loading placeholder. |

Existing primitives stay in use: `.button` (`--primary`, `--quiet`, `--sm`, `--danger`), `.card`, `.panel`, `.field`, `.input`, `.badge` (`--accent`, `--warning`, `--danger`, `--info`), `.notice`, `.state-panel`, `.filter-pill`, `.modal-*`.

Shell classes (`apps/web/src/app-shell.css`): `.site-header`, `.brand`, `.primary-nav`, `.site-header__tools`, `.site-header__badge`, `.theme-toggle`, `.site-header__account`, `.site-footer`, `.intro*`.

## Tokens

- Colour, type, radius, shadow and motion come only from `apps/web/src/design/tokens.css`. Do not add hex literals to components or shell CSS.
- Spacing: `--space-1` to `--space-16` (4px base).
- Surfaces: `--color-surface` for the page and header, `--color-surface-raised` for overlays, `--color-surface-sunken` for empty and quiet states.
- Shadows: `--shadow-xs` for cards, `--shadow-md` for menus and popovers, `--shadow-lg` for dialogs and sheets, `--shadow-focus` for focus rings.
- Motion: `--duration-fast` (120 ms) for hover and colour changes, `--duration-base` (180 ms) for entrance animation. Both are 0 ms under `prefers-reduced-motion`, and the primitives also disable their animations there.
- Layers: `--z-header` 50, `--z-overlay` 90, `--z-modal` 100.

## Mobile rules

- 16px side gutter (`--space-4`). No page-level horizontal scroll. Only the phone nav strip may scroll, inside the header.
- Tap targets are at least 44px (`2.75rem`).
- Header at 600px and below is one row, at most 56px tall: brand mark, icon nav with short labels, dataset badge and Akun. Below 900px the theme choice moves into the account menu and the brand subtitle is hidden.
- Keep the skip link and exactly one `<main>` per screen.

## Copy rules

- Bahasa Indonesia throughout.
- Never use "aman" as a claim about an area. Use it only in a negated sentence (for example "tidak pernah menyatakan suatu area aman"). The onboarding test checks this.
- Dataset badge: "Data contoh" for demo or synthetic data, "Langsung" for live data, "Status data" when the mode is unknown. Its popover explains the mode.
- Footer and intro state: "bukan layanan darurat" and "Darurat: 112".
- Number of reports is not evidence: "Jumlah laporan bukan bukti kebenaran."
- No internal terms in public copy ("cursor", "polling", "fixture" outside the presentation view).

## Map home (UI-V2-B)

- The map fills the viewport below the sticky header, and the page does not scroll. The toolbar floats top-left (search, Filter, Daftar). Zoom controls sit bottom-right, and Pusatkan appears only after the view moves. First-screen controls total five.
- From 900px the list is a left panel. Below 900px it is a bottom sheet, and an event popup is a short peek sheet. Desktop popups are anchored to their marker and close with Escape.
- Markers are buttons, labelled "<kategori>: <judul>". Only API geometry is drawn: a Point is used, and a polygon never becomes a circle. Facility pins (RS, Polisi, Damkar) are off by default, and their note says they show no readiness.
- Times stay apart: "Waktu kejadian" is the event time and "Diterbitkan" is the publication time. A missing value reads "Tidak diketahui". "N sumber" counts distinct named outlets and never means verification.
- Data comes from `/api/v1/events` and `/api/v1/events.geojson` through `published-events.ts`. The moderation queue is never read.

## Verification status (UI-V2-A)

- Typecheck and the changed or new web test files were run one at a time: `ui.test`, `preferences`, `geojson-map`, `ui-primitives`, `onboarding-intro`, plus the unchanged `landing`, `experience`, `accounts`, `pipeline-flow`, `embedding-visualization` and `local-pipeline-preview`.
- Not yet checked: the phone header height and fit in a real browser at 390px, a keyboard walk-through of every primitive in both themes, and CI.
