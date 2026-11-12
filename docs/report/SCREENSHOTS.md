# Screenshot guide: figures 3.9-3.12, 4.1 and 4.2

Regenerates the outdated report screenshots against the system as built on 12 Nov 2026. Every route
below was checked in `apps/web/src` on this commit; differences from the earlier guide are listed at the end.

## Common settings (all figures)

- Browser: Chrome or Edge, no extensions, 100% zoom, **light theme** (account menu entry `Tema: ...`, `apps/web/src/AppShell.tsx:94`).
- Desktop viewport **1440 x 900**; phone viewport **390 x 844** (DevTools device mode). Use the same device pixel ratio for every shot.
- Keep the dataset badge in frame: `Langsung` (live) or `Data contoh` (demo), from `datasetBadge()` in `AppShell.tsx:22-58`. Do not crop it.
- Mask before saving: account names, session or CSRF values, any URL carrying a token, and any private person's name or phone number that appears in source text.
- Credentials come from the operator. Do not write them into this guide, the captions or the screenshots. Do not show the `.env.local` file.
- Live shots need `npm run serve:live` (explicit request only; it makes real network and model calls). Demo shots use `npm run dev`.

## Summary

| Report figure | Replaces (old) | Route | Viewport | Dataset | Role to log in as | Preferred |
| --- | --- | --- | --- | --- | --- | --- |
| 3.9 | Old desktop map | `#peta` | 1440 x 900 | live (or demo, say so) | anonymous visitor | live |
| 3.10 | Old phone map | `#peta`, then tap "Daftar laporan" | 390 x 844 | live (or demo) | anonymous visitor | live |
| 3.11 | Old incident detail | `#detail/api/<id>` (alt: `#peta?event=<id>`) | 1440 x 900 | live (or demo) | anonymous visitor | live |
| 3.12 | Old moderator review | `#admin/tinjau` | 1440 x 900 | live | moderator (or admin) | live |
| 4.1 | Old source data | `#admin/sumber` | 1440 x 900 | **demo only** | **administrator** | demo |
| 4.2 | Old pipeline flow | `#admin/alur` | 1440 x 900 | live | moderator or admin | live |
| optional | 3D embedding | `#admin/embedding` | 1440 x 900 | live | moderator or admin | live |

## Route verification

| Hash | Screen | Who may open | Where in code |
| --- | --- | --- | --- |
| `#peta` (also `#jelajah`, `#beranda`) | public map home | everyone | `App.tsx:128-136`, `routeFromHash` at `App.tsx:138` |
| `#peta?event=<id>` | map with that event selected, popup opened | everyone | `MapHome.tsx:120-127`, `map-links.ts:11-18` |
| `#detail/api/<id>` | full incident detail (API) | everyone | `App.tsx:167-173` |
| `#pembaruan`, `#ringkasan-saya` | updates, local interests | everyone | `App.tsx:164-165` |
| `#admin/ringkasan`, `#admin/tinjau`, `#admin/alur`, `#admin/embedding`, `#admin/akun`, `#admin/sumber` | admin workspace tabs | see roles below | `admin-workspace-model.ts:25-31`, `adminWorkspaceTabFromHash` at `:56-62` |
| `#masuk` | sign in (username and password) | everyone | `App.tsx:149` |

Role rules (`admin-workspace-model.ts:74-79`, `AccountPages.tsx:904-908`):
- Moderator sees `tinjau`, `alur`, `embedding`.
- Administrator sees all six tabs, including `ringkasan`, `akun` and `sumber`.
- Anyone else gets an access gate, and the server guards apply regardless of tab visibility.

## Figure 3.9: desktop map home (`#peta`)

- **Route:** `#peta`. **Viewport:** 1440 x 900. **Light theme.** **Dataset:** live (say "live" in the caption) or demo (say "demo").
- **Role:** none. Open a private or logged-out window so the header shows no account.
- **Must be visible:** header nav Peta, Pembaruan, Area saya (`AppShell.tsx:184-187`); the dataset badge; the map with published-report markers; the list panel open beside the map (desktop shows the list panel, `MapHome.tsx:117`); the list heading `Daftar laporan, N` with its count; the search field "Cari laporan" and the Filter button (`MapHome.tsx:267-288`); the list note "Hanya laporan yang sudah terbit..." (`MapEventList.tsx:15, 52`).
- **Caption (EN):** "Figure 3.9. Public map home on desktop. Published reports appear as markers, with the list of published reports beside the map. Light theme; dataset: live (local live mode)."

## Figure 3.10: phone map and list sheet (`#peta`, 390 x 844)

- **Route:** `#peta`. Tap the button `Daftar laporan, N` to open the list sheet. Below 900 px the list is a bottom sheet, not a side panel (`MapHome.tsx:27, 114-117`; `ui/Sheet.tsx:8`).
- **Viewport:** 390 x 844. **Light theme.** **Dataset:** live or demo. **Role:** none.
- **Must be visible:** the bottom sheet rising over the map, with the same list heading and the list note; the map partly visible behind it; the dataset badge still visible at the top.
- **Do not** use `#peta?panel=map` for this shot. That URL shows the map without the list (`App.tsx:220-222`). Use it only if you want a map-only phone shot.
- **Caption (EN):** "Figure 3.10. Public map on a phone (390 x 844). The list of published reports opens as a bottom sheet over the map."

## Figure 3.11: incident detail (`#detail/api/<id>`)

- **Route:** `#detail/api/<id>`, with `<id>` copied from a published event in the list. This is the full detail page (`App.tsx:167-173`).
- **Alternative:** `#peta?event=<id>` opens the same event as a popup on the map, not the full detail page (`MapHome.tsx:120-127`). Use this only if the map context matters.
- **Viewport:** 1440 x 900. **Light theme.** **Dataset:** live or demo. **Role:** none.
- **Must be visible:** the event title and summary; the status cells `Kesegaran` (freshness), `Bukti` (evidence label) and `Relevansi` set to `Tidak dinilai` (`EventDetail.tsx:243-245`, api-event branch); the section "Klaim per sumber" with heading "Bukti" (`EventDetail.tsx:288`); the time fields as the source gave them, with no invented times.
- **Caption (EN):** "Figure 3.11. Incident detail for one published report. Freshness, evidence label and relevance are shown separately; relevance is not assessed here."

## Figure 3.12: moderator review (`#admin/tinjau`)

- **Route:** `#admin/tinjau`. **Viewport:** 1440 x 900. **Light theme.** **Dataset:** live. **Role:** moderator (or administrator).
- **Must be visible:** the workspace header and tab rail with "Tinjau bukti" active (tab label, `admin-workspace-model.ts:27`); the review heading "Tinjau Bukti & Moderasi Insiden" (`ModeratorReview.tsx:765`); the queue filter `Perbedaan (N)` (`ModeratorReview.tsx:908`), which appears only when a queued proposal has a discrepancy; the discrepancy callout "Perbedaan terdeteksi, diringkas agen AI" (`ModeratorReview.tsx:1055`); the claims with their evidence labels; the actions "Setujui & Terbitkan" (`:1217`), "Minta Bukti" (`:1235`) and "Tolak" (`:1226`).
- **Dependency:** the callout needs a queued proposal with `has_discrepancy`. If none is queued when you shoot, wait for one or do not claim the callout in the caption. An empty queue shows "Semua proposal telah ditinjau" (`ModeratorReview.tsx:876`).
- **Caption (EN):** "Figure 3.12. Moderator review of a queued proposal with a flagged discrepancy: the AI summary, the claims with evidence labels, and the moderator actions. Reject never publishes."

## Figure 4.1: source data (`#admin/sumber`)

- **Route:** `#admin/sumber`. **Viewport:** 1440 x 900. **Light theme.** **Dataset: demo only.** **Role: administrator.** A moderator does not see this tab (`admin-workspace-model.ts:31` `access: "admin"`; `AppShell.tsx:86` lists it for admins only).
- **Dataset caveat:** in live mode this tab shows "Pratinjau demo tidak tersedia dalam mode live." and disables the source requests (`UnifiedSourceExplorer.tsx:538`, buttons disabled at `:541, :550`). Take this shot in demo: `npm run dev` with the demo dataset (default in `apps/worker/wrangler.toml`). For a logged-in administrator, use the synthetic account demo: `npm run accounts:local -- --enable --demo --state accounts-demo`, then `WASPADA_LOCAL_ACCOUNTS=true npm run dev` (CLAUDE.md).
- **Must be visible:** the badge `Data contoh`; the header "Demo sumber · pratinjau terpisah" and "Belum melalui publikasi Waspada" (`UnifiedSourceExplorer.tsx`, intro); the status "DEMO · belum dipublikasi" and the note "Default lokal; permintaan penyedia hanya setelah tindakan Anda." (`:535-538`). The preview is requested only after you press the fetch button, so the screen must show the state before that action.
- **Caption (EN):** "Figure 4.1. Source data preview (demo dataset, administrator). The preview is separate from published reports and is requested only after an explicit action."

## Figure 4.2: agent pipeline flow (`#admin/alur`)

- **Route:** `#admin/alur`. **Viewport:** 1440 x 900 only. Below 900 px this tab shows an empty state, not the flow (`admin-workspace-model.ts:35`, `AdminWorkspace.tsx:110`). **Light theme.** **Dataset:** live (the flow shows real counts). **Role:** moderator or administrator.
- **Must be visible:** the heading "Alur agen" (`PipelineFlow.tsx:485`); the lede that says the counts show workflow flow, not proof that an incident is true or an area is safe (`PipelineFlow.tsx:486-488`); the stage nodes from `PIPELINE_NODE_META` (`pipeline-flow-model.ts:28-60`): Sumber PetaBencana, Sumber BMKG, Sumber RSS (14 feed), Saring duplikat, Saring deterministik, Triase AI, Revisi dan potongan teks, Antrean AI, Interpretasi, Embedding, Pencarian bukti, Pengaitan insiden, Usulan peristiwa, Gerbang publikasi otomatis, Tinjauan diskrepansi, Terbit ke publik, NineRouter, Siklus polling; the health labels (for example "Berjalan", "Menunggu", "Gagal, perlu dicek"; `pipeline-flow-model.ts`).
- **Optional drawer shot:** open one stage to show "Hitungan" and "Rincian terbaru" (`PipelineFlow.tsx:221, 234`). The drawer lists item references, status, failure text and, where the source gave one, the item title (`PipelineFlow.tsx:243-252`). Titles are source text: mask or skip the shot if a title names a private person. No vectors are shown.
- **Caption (EN):** "Figure 4.2. Agent pipeline flow from source to publication (moderator view, live dataset). Counts show activity only; they are not corroboration and do not show that an area is safe."

## Optional: 3D embedding view (`#admin/embedding`)

- **Route:** `#admin/embedding`. **Viewport:** 1440 x 900 (below 900 px it is an empty state, `admin-workspace-model.ts:35`). **Role:** moderator or administrator. **Dataset:** live.
- **Must be visible:** the heading "Visualisasi 3D Embedding Potongan Teks" (`Embedding3DVisualization.tsx:468`); the 3D point cloud. Check that no raw vector numbers appear on screen (the list heading there is "Daftar Vektor Chunk Terproyeksi", `:671`, so check its contents before you publish the shot).
- **Caption (EN):** "Optional figure. Three-dimensional view of evidence-chunk embeddings for moderators, projected from 768 dimensions. Vectors are not published; chunk text is moderator-only."

## What differs from the earlier guide

1. `#admin/sumber` is admin-only, not moderator (`admin-workspace-model.ts:31`; `AppShell.tsx:86`).
2. The source tab is demo-only. In live mode it shows a disabled notice (`UnifiedSourceExplorer.tsx:538`).
3. The flow and 3D tabs need a 900 px-wide screen. The phone shows an empty state (`AdminWorkspace.tsx:58-62, 110`).
4. `#peta?event=<id>` opens a map popup; the full detail page is `#detail/api/<id>` (`MapHome.tsx:120-127`; `App.tsx:167-173`).
5. Legacy hashes still resolve but should not appear in the report: `#tinjau-bukti`, `#alur-agen`, `#embedding-3d`, `#visualisasi-3d`, `#demo-sumber`, `#admin` (`admin-workspace-model.ts:38-46`). `serve:live` still prints `#tinjau-bukti` and `#visualisasi-3d` (`tools/serve-live-pipeline.ts:657-659`); use the new hashes in the captions.
6. The 3D view is called "Embedding 3D" in the tab rail (`admin-workspace-model.ts:29`) and "Visualisasi 3D" in the account menu (`AppShell.tsx:85`). Use the name that matches the screenshot.
7. A moderator's account menu shows "Ruang kerja admin" pointing to `#admin/tinjau` only (`AppShell.tsx:87-88`). Administrators get all five admin entries.
8. Unknown `#admin/<tab>` opens `ringkasan` (`admin-workspace-model.ts:59`).
