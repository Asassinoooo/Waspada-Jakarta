# GUI-03 design audit (25 Nov 2026)

**Scope:** public web pages on the hosted site, with real published data. Viewports 390×844 and 1440×900, light and dark. `tools/gui/gui-shots.ts` captured 48 screenshots; the 13 cited below are committed in `docs/testing/evidence/2026-11-25/gui/before/`, and re-running the script reproduces the rest. The sample event for detail and selection is `inc-rep-source-detik-news-4afa6cb879a4e5c3`, version 12, 5 sources.

**Not captured yet:**
- Admin and moderator screens. These need the synthetic harness and a local web build.
- Android screens. These need a device, emulator or golden tests.

They will be audited before any change in those areas.

**Status:** findings only. Per the plan, no design change is made until the owner chooses a direction.

## Findings, ranked by impact

| # | Area | Finding | Evidence | Impact |
|---|---|---|---|---|
| 1 | Event detail | The mobile page is **10,862 px tall**. Each claim is a full card, and the 5 sources give about 20 claims. Then come 12 history versions, each about 200 px, oldest first. The facts a reader needs are lost in a long scroll. | `detail-390-*.png` | High |
| 2 | Titles | Titles are the first source sentence, cut with "…", even on the detail page. Example: "Pemerintah Provinsi DKI Jakarta melalui BPBD melakukan penanganan terhadap longsor susulan yang terjadi di Pejaten…". The detail summary repeats the same sentence 3–4 times. This is a content and agent issue, but the UI shows it at the largest size. | `detail-*`, `peta-1440-*` | High |
| 3 | Map | The pins are small red dots with a "!" glyph. They are low-contrast on the busy grey basemap, and worse in dark mode, where they also compete with the basemap's "+" facility icons. In the 24-hour view, 5 of 11 reports have no point, so the map looks almost empty. | `peta-*`, `peta-selected-1440-dark.png` | High |
| 4 | List cards | Each card spends 3–4 lines on what is missing ("Lokasi tidak tercatat", "Waktu kejadian tidak disebutkan", "Tanpa titik"). On a 1440 px screen only about 2 cards fit above the fold. | `peta-1440-*` | Medium |
| 5 | Area saya | The page is **3,442 px** on mobile: three disclaimers come before any input, then four nearly identical interest forms (Tempat/Layanan/Institusi/Kelompok), each with "0/30 minat · maksimal 128 karakter Unicode per nilai", then 10 checkboxes. The nav says "Area saya" but the page title says "Ringkasan saya". | `ringkasan-saya-390-light.png` | Medium |
| 6 | Mobile header | The live-status indicator shrinks to an unlabeled circle with a dot next to "Akun". It reads like a broken avatar. | `peta-390-*`, `masuk-390-dark.png` | Medium |
| 7 | Map state | Opening `#peta?event=…` drops the 24-hour filter: the count jumps from 11 to 75 and the banner disappears, with nothing to tell the reader. | `peta-selected-*` vs `peta-*` | Medium |
| 8 | Map overlays (mobile) | The impact legend sits over the middle of the map, and the footer card plus zoom controls cover the bottom. Together they hide about 20% of the map. | `peta-390-*` | Medium |
| 9 | Detail wording | Internal terms are shown to the public: "Proyeksi publik", a "Data API" chip and "Detail peristiwa". There are 7 time rows in one block with no grouping. The time fields have to stay separate (invariant), but they can be grouped as Kejadian / Sumber / Layanan. | `detail-0` crop | Low–Medium |
| 10 | Selected-event sheet | "Tutup" shows a heavy focus ring as soon as the sheet opens. Labels such as "Dipublikasikan sumber" wrap onto 2 lines. | `peta-selected-390-light.png` | Low |
| 11 | `#unduh` | The "File untuk perangkat lain (2)" disclosure has no visible chevron, so it doesn't look clickable. The rest of the page reads well. | `unduh-1440-light.png` | Low |
| 12 | Pembaruan | The empty state is fine. The lead sentence is hard to parse: "Hanya ringkasan perubahan yang cocok dengan minat tersimpan dan detail kejadian publik terkini yang ditampilkan." | `pembaruan-390-dark.png` | Low |

**Works well and should be kept:**
- the intro dialog
- the `#masuk` form hierarchy
- the `#unduh` structure
- dark-mode contrast on text pages
- the consistent footer disclaimer
- the "Lihat perubahan" disclosure

## Directions for the owner to choose from

- **A. Fix in place (recommended first).** Keep the current visual language and fix #1–#8:
  - Detail: collapse claims by source, with 3 shown plus "Tampilkan semua"; history newest first, 3 shown, the rest collapsed.
  - Larger pins with higher contrast; in dark mode, a quieter basemap style or fewer facility icons.
  - Compact list cards: missing fields go into one muted line.
  - Area saya: one combined interest form, with the disclaimers moved into one note.
  - Mobile header: drop the status circle or give it a label.
  - Keep the 24-hour filter when a selected event is opened.
  - Collapse the legend into a button on mobile.

  Low risk, a few days, no change to contracts.
- **B. Visual refresh.** Everything in A, plus new type scale, color and card styling: an editorial headline style, severity colors and a reworked map chrome. This needs mockups approved before any build.
- **C. Content fix upstream.** Have the agent produce a short headline (≤ 80 characters) and a deduplicated summary. This fixes #2 at the source and helps every screen, but it touches the intelligence prompt and contract, so it needs its own task ID.

A and C are independent and can run in parallel.

## Invariants every fix keeps

- No radius, polygon or invented point.
- Events without a point are never pinned.
- No "aman" wording.
- Event, source, publication and fetch times stay separate.
- `a11y:audit` stays at 0 serious or critical violations.
