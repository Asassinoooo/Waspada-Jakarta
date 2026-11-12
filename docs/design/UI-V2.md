# UI-V2 design principles

Status: UI-V2-A (app shell, simplified navigation, UI primitives, first-visit intro) and UI-V2-B (map-first home) are in place. UI-V2-C (administrator workspace with tabs) is on `work/UI-V2-C-admin-workspace`. Phase D is planned in `docs/IMPLEMENTATION_BACKLOG.md`. Tokens and primitives extend UI-SYSTEM-01 and UI-SYSTEM-02 and keep their rules.

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
| `#admin/ringkasan`, `#admin`, `#admin-workspace` | administrator workspace, Ringkasan tab | Admin role. |
| `#admin/akun` | workspace, Akun & peran tab | Admin role. |
| `#admin/tinjau`, `#tinjau-bukti` | workspace, Tinjau bukti tab | Moderator or admin role. |
| `#admin/alur`, `#alur-agen` | workspace, Alur agen tab | Moderator or admin role. |
| `#admin/embedding`, `#visualisasi-3d`, `#embedding-3d` | workspace, Embedding 3D tab | Moderator or admin role. |
| `#admin/sumber`, `#demo-sumber` | workspace, Demo sumber tab | Admin role only. |

Every admin hash opens the workspace on its tab. See "Administrator workspace" below.

## Administrator workspace (UI-V2-C)

One screen, `#admin/<tab>`, with real tabs on the Tabs primitive. Routing and roles live in `apps/web/src/admin-workspace-model.ts` (pure, unit-tested); the shell is `AdminWorkspace.tsx`.

| Tab | Hash | Role | Content |
| --- | --- | --- | --- |
| Ringkasan | `#admin/ringkasan` | admin | Stat tiles, layer list, and the read-only report explorer with its honesty notes. |
| Tinjau bukti | `#admin/tinjau` | moderator, admin | Moderator review (`ModeratorReview`). |
| Alur agen | `#admin/alur` | moderator, admin | Pipeline flow (`PipelineFlow`, @xyflow/react). |
| Embedding 3D | `#admin/embedding` | moderator, admin | 3D embedding view (three.js). |
| Akun & peran | `#admin/akun` | admin | The user-management panel from `#akun` (`AdminAccountsPanel`). |
| Demo sumber | `#admin/sumber` | admin | Source preview with its own demo guard (`UnifiedSourceExplorer`). |

- **Layout.** The header holds the title "Ruang kerja", the active tab's subtitle, one primary link where the tab has a next step (Ringkasan to Tinjau bukti, Tinjau bukti to Alur agen), the dataset badge, and a ⋯ menu (Kembali ke peta, Akun saya, Bantuan, theme). From 901px the tabs are a 200px vertical rail with icons. At 900px and below they are a horizontal strip that scrolls. The page has one `<main>` and one `<h1>`. The public header is not shown here.
- **Roles.** Admins see six tabs and moderators see three. Users, inactive accounts and anonymous visitors get the existing `AccountAccessGate` and no tab is mounted. Tabs only hide UI. The role check in `App.tsx`, the Worker routes and the L4 gate still decide every request.
- **Hashes.** Clicking a tab replaces the hash, so it adds no history entry and does not re-check the session. A new hash, such as a link from elsewhere, remounts the workspace on that tab. Legacy hashes open the matching tab and are rewritten to `#admin/<tab>`. A tab the viewer may not open falls back to their first allowed tab.
- **Narrow screens.** Ringkasan, Tinjau, Akun and Demo sumber work at phone width. Alur and Embedding show "Buka di layar yang lebih lebar untuk tampilan ini." and neither mounts its canvas nor loads its chunk. The old blanket below-900px admin block is gone.
- **Loading.** Only the open tab mounts. Each tab is `React.lazy` with a skeleton. Chunks: `admin-entry` (workspace shell and styles), `AdminDashboard`, `ModeratorReview`, `pipeline-flow-entry` (@xyflow/react), `Embedding3DVisualization` (three.js) and `AdminSourceTab` (source map). Akun uses `AccountPages`, which the main chunk already loads.
- **Session.** A background session refresh (every 60 s, on focus, or after an action) keeps the last known session on screen until the new one arrives. The workspace therefore stays mounted, and a moderator's unsent reason is not lost.
- **Honesty.** Stat tiles count only what has loaded: "Jumlah laporan bukan bukti kebenaran, dan angka nol tidak menyatakan kondisi lapangan." The source tab keeps its demo badge ("DEMO SUMBER — pratinjau data publik; bukan peringatan Waspada").

## Primitives

Source in `apps/web/src/ui/`. Styles in `apps/web/src/design/components.css`. Keyboard helpers in `ui/a11y.ts` are pure and unit-tested.

| Primitive | Classes | Behaviour |
| --- | --- | --- |
| Dialog | `.modal-overlay.ui-overlay` > `.modal-dialog.ui-dialog` | `aria-modal`, named by its heading. Focus moves in, Tab cycles inside, Escape closes, focus returns to the opener. |
| Sheet | `.sheet-overlay--left` or `--right` > `.sheet` | Rises from the bottom below 900px. Side panel from 900px. Same semantics as Dialog. |
| Tabs | `.tabs`, `.tabs__tab`, `.tabs__panel`, `.tabs__icon` | Roving tabindex. ArrowLeft and ArrowRight wrap for the horizontal strip; `orientation="vertical"` uses ArrowUp and ArrowDown for the rail. Home and End jump. Optional icon per tab. |
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

## Verification status (UI-V2-C)

- `npm run typecheck` (web) passes. Changed or new web test files were run one at a time: `admin-workspace` 16 (new), `admin-dashboard` 9, `pipeline-flow` 5, `ui` 23, `embedding-visualization` 4, `accounts` 16, `ui-primitives` 11, `moderator-review` 26, `unified-source-explorer` 14, `preferences` 13, `geojson-map` 9.
- `npm run build --workspace=@waspada/web` passes (vite only). three.js appears only in the `Embedding3DVisualization` chunk and @xyflow/react only in `pipeline-flow-entry`. The main `index` chunk contains neither.
- Not checked: the workspace in a browser at 390px and 900px, a keyboard walk-through of the rail in both themes, and CI.
