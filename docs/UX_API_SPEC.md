# Waspada Jakarta — UI flows and API contract

**Status:** SPEC-03 design baseline accepted on 24 September 2026. The local Worker serves synthetic `GET /api/v1/context`, `/api/v1/events`, `/api/v1/events/{event_id}`, and `/api/v1/events/{event_id}/history`. API-PROJECT-CORE and API-GEOMETRY-CORE provide pure Layer 4 allowlists for `EventView`, `EventDetail`, and GeoJSON; the detail/history handlers read only fictional demo fixtures and do not wire those projectors to a database. GeoJSON HTTP reads, a live public reader, and the broader public and moderator flows remain unimplemented; API-01/MOD-01 must implement and test them. The optional GeoJSON `bbox` uses the application envelope in [ADR-018](decisions/ADR-018-jakarta-geojson-query-envelope.md); it is a query bound, not an official boundary or event warning area.

## 1. Product and interaction rules

The site is a Bahasa Indonesia situational-awareness tool for Jakarta residents, visitors and moderators. Public reading does not require an account. The UI reports sourced information; it does not dispatch responders, guarantee route safety, predict crime or create hazard boundaries. The desktop and mobile layouts share one published-data projection and one set of status meanings.

The category filter uses the ten primary categories below; a record has one primary category plus separately displayed tags. Tags refine discovery and do not replace lifecycle, freshness or evidence labels.

| Contract category | Label shown in the UI |
| --- | --- |
| `crime_personal_security` | Kejahatan dan keamanan pribadi |
| `demonstrations_public_gatherings` | Demonstrasi dan keramaian publik |
| `crowds_major_events` | Kerumunan dan acara besar |
| `violence_immediate_threats` | Kekerasan dan ancaman langsung |
| `disasters_weather` | Bencana dan cuaca |
| `fires_infrastructure_hazards` | Kebakaran dan bahaya infrastruktur |
| `transport_road_incidents` | Transportasi dan insiden jalan |
| `utilities_essential_services` | Utilitas dan layanan penting |
| `health_environmental_advisories` | Pemberitahuan kesehatan dan lingkungan |
| `group_specific_critical_notices` | Pemberitahuan penting untuk kelompok tertentu |

Every event, impact and evidence claim keeps separate meanings visible:

| Dimension | UI label | Meaning |
| --- | --- | --- |
| Event or impact lifecycle | Direncanakan, Berlangsung, Selesai, Dibatalkan, or Belum diketahui | What the evidence says about the event or specific impact. An event and its impacts can differ. |
| Freshness | Pembaruan dalam batas waktu, Perlu diperbarui, or Batas tinjau lewat | Whether information remains within its review window. Show issuer validity separately. An expired warning leaves the active-warning view; expiry does not mean the condition is safe or an incident is resolved. |
| Evidence | Pemberitahuan resmi (sesuai kewenangan), Dilaporkan oleh [source], Laporan warga ([provider]), or Didukung laporan independen | What kind of source supports a specific claim. Show disputed/withdrawn support explicitly when relevant; do not call model confidence “verified”. |
| Relevance | Terkait dengan [place/service/group] | Why an event appears for this user or filter. Relevance is a match to a selected interest, not a truth or severity rating. |

Times are always labelled by what they describe. Show event/observation time separately from the source publication time, any issuer validity period, and the time the system fetched the source. Fetching a page again does not change the reported event time. Render instants in `Asia/Jakarta` (WIB) while retaining the source offset in the source metadata. If time precision is only a date or range, say so rather than showing a false exact minute.

Map shapes follow cited evidence: a reported incident is a point at supported precision; an official warning boundary is a source-defined polygon with its scope and validity; a road or service effect is a supported segment, stop or service reference. Never expand a point into a danger radius. Items scoped to a group/service without useful geography remain in the list and briefing and carry a “Tidak dipetakan” explanation.

The server chooses one dataset for the running API instance. The public context response identifies the deployment mode as `live` or `demo`; individual records separately identify `dataset_kind` as `live`, `historical` or `synthetic`. No public request parameter switches datasets. A demo instance displays a persistent banner such as **“DEMO — data historis/sintetis; bukan peringatan langsung.”** Its event/map/briefing responses contain only that instance's dataset. A live instance cannot return demo records, and a demo instance cannot include live warnings. Moderator sessions and all moderator reads/writes are bound to the same server-selected dataset.

## 2. Public discovery and event detail

### Desktop map and linked feed

```text
┌ Waspada Jakarta ───────────────────────────── [Ringkasan saya] [Masuk moderator] ┐
│ [DEMO — data historis/sintetis; bukan peringatan langsung]                        │
├──────────────────────────────────────────────────────────────────────────────────┤
│ [Cari tempat, jalan, layanan…] [Waktu ▾] [Kategori ▾] [Status ▾] [Filter lainnya] │
├───────────────────────────────┬──────────────────────────────────────────────────┤
│ 12 item • 09.24 WIB            │                                                  │
│ Ketersediaan sumber:           │                 PETA JAKARTA                     │
│ BMKG 09.20 • PetaBencana 09.12 │       ● titik laporan       ▧ batas resmi        │
│                                │       ━ dampak ruas/layanan                     │
│ [Banjir • Berlangsung]         │                                                  │
│ Dilaporkan oleh PetaBencana    │                                                  │
│ Observasi 09.05 • pembaruan    │                                                  │
│ dalam batas waktu              │                                                  │
│ Kel. X • Terkait: area pilihan │                                                  │
│                                │                                                  │
│ [Peringatan cuaca • Aktif]     │                                                  │
│ Pemberitahuan resmi BMKG       │                                                  │
│ Berlaku 09.00–12.00 WIB        │                                                  │
│ Batas resmi • pembaruan dalam  │                                                  │
│ batas waktu                    │                                                  │
│                                │                                                  │
│ [Pemuatan lainnya]             │                                                  │
└───────────────────────────────┴──────────────────────────────────────────────────┘
```

The left feed is the accessible source of truth for all results, including events with no map geometry. Selecting a feed item highlights only its supported geometry. The map key distinguishes point, official boundary and segment with icon/line pattern as well as color; no visual style implies an unsubstantiated danger score. The results count, active filters, source availability and empty-state message remain visible. Result pages use a “Muat lainnya” control backed by a bounded cursor, not unbounded infinite loading.

The search supports Jakarta place/service names and category selection. Filters include category (the ten primary categories and tags), event-time range, lifecycle, freshness, source/evidence type, and optional place/service/group. Defaults prioritize current and upcoming information without removing older items from explicit history search. Empty results say **“Tidak ada laporan yang cocok. Ini bukan pernyataan bahwa kondisi aman.”** If a source is unavailable, identify it and its last successful fetch separately from the time of any reported observation.

### Mobile map/feed and item selection

```text
┌ Waspada Jakarta                 [☰] ┐
│ DEMO — data historis/sintetis        │
├─────────────────────────────────────┤
│ [Cari tempat atau layanan…]         │
│ [Filter] [Daftar] [Peta]            │
│ 12 item • sumber diperbarui 09.24   │
│ ┌ Banjir • Berlangsung             ┐│
│ │ Laporan warga • observasi 09.05  ││
│ │ Pembaruan: dalam batas waktu  ││
│ │ Kel. X • [Lihat detail]          ││
│ └──────────────────────────────────┘│
│ [Muat lainnya]                      │
└─────────────────────────────────────┘
```

The mobile default is the list, with a visible switch to the full-screen map. Filters open in a labelled sheet with an explicit “Terapkan” action and a clear/reset action. Map markers open a bottom sheet containing the event title, category, event time, lifecycle, freshness, evidence label and “Buka detail”; a list control remains available. The map has zoom controls and a “Kembali ke daftar” action. For a notice without coordinates, the detail page says why it is not shown on the map.

### Event detail and history

```text
┌ ‹ Kembali ke hasil ─────────────────────────────────────────────────────┐
│ Banjir dilaporkan di Kelurahan X                 [Bagikan tautan]        │
│ Bencana dan cuaca • Berlangsung • Pembaruan dalam batas waktu           │
│ Bukti: Laporan warga (PetaBencana) • bukan konfirmasi penyebab banjir    │
│ Terkait dengan: Kelurahan X                                              │
├────────────────────────────────────────────────────────────────────────┤
│ Waktu kejadian/observasi  24 Sep, 09.05 WIB (laporan warga)              │
│ Sumber diterbitkan        24 Sep, 09.08 WIB                              │
│ Validitas peringatan      Tidak dinyatakan                               │
│ Diterima sistem           24 Sep, 09.12 WIB (bukan waktu observasi)      │
│                                                                        │
│ Ringkasan klaim yang didukung dan keterangan yang belum diketahui       │
│ [Peta: titik laporan, ketelitian sesuai sumber]                         │
│                                                                        │
│ Dampak terpisah: [Bus X dialihkan • Berlangsung • Perlu diperbarui]     │
│ Dampak ini punya lokasi/waktu/evidence sendiri.                         │
├ Riwayat versi ──────────────────────────────────────────────────────────┤
│ 09.12 • Observasi dimuat dari PetaBencana [buka sumber]                 │
│ 09.30 • Rute Bus X diperbarui dari operator [buka sumber]                │
├ Sumber dan bukti ──────────────────────────────────────────────────────┤
│ PetaBencana • observasi • tautan dan waktu sumber                       │
│ Operator Bus X • pemberitahuan resmi atas layanan • tautan               │
└────────────────────────────────────────────────────────────────────────┘
```

The detail view separates claims, impacts, geometry and sources. Each claim has its own attribution/evidence label, event or observation time, qualifiers and source link; do not imply that one source supports every detail. A disputed claim is labelled and its limitation is stated. Corrections and retractions appear in history with the public version/time and reason suitable for public display, while private moderator notes and personal data are excluded. Older versions stay in event history but cannot be mistaken for current status. A historical crime item has its reported date and attribution; the UI must not imply a present danger zone.

## 3. Preferences, briefing and in-site updates

```text
Ringkasan saya
├ Tempat: [Kecamatan / kelurahan / tempat umum] [Tambah]
├ Layanan: [operator / rute / fasilitas] [Tambah]
├ Kelompok: [mahasiswa] [orang tua] [pengguna angkutan umum] [Tambah]
├ Kategori yang diikuti: [pilih kategori]
└ [Simpan di perangkat ini] [Hapus semua minat]

Yang mungkin relevan • disusun dari informasi terbit
├ [Kartu ringkas event]  Mengapa muncul: cocok dengan layanan yang Anda ikuti
├ Perubahan sejak kunjungan terakhir • 09.30 WIB
│  Rute Bus X: status diperbarui oleh operator • [Lihat sumber/perubahan]
└ [Periksa pembaruan]
```

Preferences are stored locally in the browser for the MVP; public users do not register or create a server account. Explain that clearing browser data removes the saved interests. Place/service/group names may be sent as the minimum request data needed to build a briefing, but are not persisted server-side by this contract; never send precise device location or infer a user's identity. The user can inspect and clear their interests.

The briefing contains only published claims and links to their event details. Each item explains the match, and event updates are deduplicated by event/impact version so repeated coverage does not create duplicate cards. Show material changes with prior/new values where public history permits. Poll in-site updates while the page is open; show the time of the last successful check and a manual refresh. No browser push is in MVP. If there are no matches, say **“Belum ada informasi terbit yang cocok dengan minat Anda.”** Do not phrase that as “semua aman”. If the system is offline, keep already loaded published information labelled with its known source times and state that it may be out of date.

## 4. Moderator workspace

Public visitors have no registration flow. The moderator login is reached through “Masuk moderator”; the protected app has no self-service account creation. On login, explain that it is a restricted workspace and do not expose whether a username exists. A signed-out/expired session sends the user back to login and then returns to the intended protected page.

```text
Waspada Jakarta • Moderator             Lingkungan: DEMO     [Keluar]
├ Antrean | Sumber | Riwayat tindakan
│
│ Antrean review • 8                              [Cari ID / lokasi]
│ ┌ Klaim 1                                  ┌ Sumber asli ─────────┐
│ │ Kandidat: Banjir Kel. X                  │ tautan • diterbitkan │
│ │ Waktu/lokasi terdeteksi + presisi        │ teks terpilih/span   │
│ │ Pendukung: report/origin + span           │ status izin sumber  │
│ │ Bertentangan: report/origin + span        └─────────────────────┘
│ │ Konflik: 2 sumber berbeda soal jam        │
│ └────────────────────────────────────────────────────────────────┘
│  [Bandingkan versi] [Buka event terkait] [Lihat geometri + asalnya]
│  [Terbitkan klaim yang lolos] [Simpan koreksi dengan bukti]
│  [Tahan untuk peninjauan] [Tolak klaim] [Tarik versi terbit]
│  Alasan keputusan: [wajib untuk koreksi, penolakan, atau penarikan]
```

The review screen compares immutable source revisions, highlighted evidence spans, origin relationships, contradictions, event/impact versions and proposed public fields side-by-side. Moderators can review one claim at a time; a supported claim may proceed while a disputed detail stays held. A moderator's correction supplies evidence references and a reason and re-enters the same publication gate as any other proposal. “Terbitkan” is disabled while required evidence, source eligibility, time, geometry or version checks fail; model confidence, JSON validity or a moderator checkbox cannot substitute for support.

Other screens support:

- **Sumber:** inspect source identity, remit, access restrictions, current approval and connector health separately. Approving a source is an explicit authorized action with a reason and audit entry; approval does not approve every claim from it.
- **Merge candidates:** compare shared event identity, event time, place and evidence origins. Proximity/headline similarity alone cannot merge events. A merge is versioned and audited.
- **Published history:** inspect corrections and retractions and affected event/impact versions. Retraction asks for a reason, identifies affected claims and invalidates dependent public views; it does not rewrite prior audit records.
- **Role/access:** show the current role and permitted actions; deny unassigned actions at the API as well as in the interface.

Before a write, show the target event/impact version. Writes include that expected version and an idempotency key. A stale-version response keeps the draft visible, displays the newer version and its changes, and requires the moderator to reload/reconcile before submitting again; never silently overwrite. A duplicate retry returns the original action result and does not create another version/audit action. Destructive-seeming public actions such as retraction require a typed reason and a final review summary, but no extra confirmation step is required for ordinary reversible navigation.

## 5. User task flows and exceptional states

**Find an applicable report:** open the map/list → search or choose a place/service → filter category, event time, lifecycle/freshness as needed → inspect the linked result → open detail → read the relevant claim/effect, time labels, evidence and source → return to results. Completion means the user can identify the event time, evidence kind, current freshness and why it may apply; map/list parity allows task completion without a map.

**Follow an update:** open “Ringkasan saya” → add a place, service, group or category → save locally → review a matched item and its “Mengapa muncul” explanation → later see a deduplicated change → follow its version history/source → remove an interest or clear all saved interests.

**Review a disputed claim:** moderator signs in → opens a queued item → compares supporting and contrary evidence and source eligibility → checks affected event/impact version → edits/corrects only the supported field(s), or leaves the claim held → enters reason/evidence → submits with current version and idempotency key → receives the committed version or a conflict to reconcile → verifies the public detail/history projection.

**Approve a source:** moderator opens source record → checks remit, access method/restrictions and review evidence → approves/rejects with reason → action is audited. Source registration/approval never directly publishes a candidate event.

Public empty, loading and error states are explicit: skeletons while loading; “Tidak ada laporan yang cocok” plus source coverage for empty results; a retry action for network/5xx errors; filters remain available if the map service fails; a list-only fallback if tiles cannot load. A 429 response shows a retry time. Public 404 means no published item is available for that identifier. Moderator states distinguish expired/invalid session (401), insufficient role (403), stale version (409), invalid domain action (422), rate limit (429) and temporary service failure (5xx); error text does not disclose private drafts or source credentials. An unauthorized ID and a nonexistent private ID may share the same 404 response.

All controls have visible labels, keyboard focus and screen-reader names. Color is never the only carrier of category, lifecycle, freshness or evidence. The feed and details work at 200% zoom; dialogs/sheets manage focus and escape behavior; map features have matching textual list entries and accessible summaries.

## 6. API contract alignment

The planned API is an application projection, not the storage schema. It returns only published event and impact versions on public routes. It omits unreviewed proposals, private notes, moderator/account identifiers, raw personal details and private source metadata. Public evidence references contain only the minimum attribution, public source link, relevant date and support label needed to explain a published claim. GeoJSON exposes only the validated, published geometry and a stable public feature reference.

Stable endpoint responsibilities for the MVP are: public context (including server-selected dataset label), bounded event list, event detail, event version/history, GeoJSON, and briefing generation; moderator login, logout, current session, bounded review queue/detail, review/correction/retraction, and source approval. Polling reads published changes since a cursor for in-site updates. Pagination is bounded, stable under event-version changes, and supports explicit next cursors; filters have maximum ranges/page sizes, enum validation and stable ordering. No list request triggers source acquisition, model inference or L3 investigation.

The machine-readable OpenAPI 3.1 definition is [docs/api/openapi.yaml](api/openapi.yaml). It defines 16 operations for context, event discovery/detail/history, GeoJSON, local-interest briefings, update polling, moderator session/CSRF, review, retraction and source approval, with reusable closed projections, shared errors and representative synthetic request/response examples. It parsed in WSL; all local references resolve, and operation IDs are unique. The local Worker tests context/list and synthetic detail/history response shapes. GeoJSON, database-backed publication reads, and the remaining API/MOD operations still require implementation and runtime conformance checks.

Projection mapping is deliberate. Public `EventView` keeps `event_id`, `version`, title/summary, category/tags, lifecycle, freshness, event time and validity from schema 2.0 `Event`; `scope` translates internal place/service/institution/audience IDs to public display names. `claims` are built from schema `PublishedClaim`s: L4-resolved evidence references become permitted public source attributions, URLs, dates and short allowed excerpts, while internal report revision IDs, text hashes, offsets, model runs and moderation data stay private. `impacts` resolve the event's versioned `impact_refs` to the matching `Impact` records. Event detail adds only validated published geometry. The review projection instead preserves evidence hash/span references and origin relationships for moderator inspection. These are read/write projections, not alternate sources of truth; L4 validates each write against the current schema records and event version.

Moderator APIs use a server-side session with an opaque random cookie, CSRF protection for every state-changing request, strict role checks on every endpoint, audit records, optimistic concurrency and idempotency keys. There is no public registration or bearer token in browser storage. The design is accepted in [ADR-006](decisions/ADR-006-moderator-auth.md); account provisioning, session parameters and implementation checks remain open.
