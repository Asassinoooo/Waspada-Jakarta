# GUI-03: notes for the owner (27 Nov 2026)

On 27 Nov 2026 the owner asked for the redesign to be applied without review, aiming for a minimal UI that doesn't clutter the screen, and for anything that needs their decision to be written down first. This file lists those decisions. None of them was decided for you.

## Decisions waiting for you

1. **Event titles and summaries (audit finding #2, direction C).**
   - **Problem:** titles are the first source sentence cut with "…", and summaries repeat the same sentence 3–4 times.
   - **Why it isn't fixed:** the cause is the AI pipeline's text, not the UI. Fixing it means changing the intelligence prompt and possibly the proposal contract.
   - **Owner decision (28 Nov 2026): keep it as is.** No content task and no prompt change. List titles stay clamped to 3 lines.
2. **Logo click (from PR #5).**
   - **Problem:** clicking "WJ" now collapses the brand instead of going to the map. The element is still an `<a href="#peta">` with `aria-expanded`, so screen readers announce a link that doesn't navigate.
   - **Options:**
     - **(a)** go back to a normal home link;
     - **(b)** keep the collapse, but make it a separate button;
     - **(c)** keep as is.

   I left it unchanged because it's your teammate's feature.
3. **Page name.** The nav says "Area saya" and the page title says "Ringkasan saya". Should both be "Area saya"? It's a one-line change. Tests and the STD mention "Ringkasan saya", so I didn't rename it.
4. **Main bundle size.** It is 102.35 kB gzip after PERF-09c, about 2.4 kB over the 100 kB target. Should I find more to lazy-load, or accept the current size?
5. **Personal files in Git history.**
   - **What was removed:** the UAT CSV (participant names), a report PDF (name and student ID) and the signed MoU. They're gone from `main` (25a64cf) but still in the history of the public repo.
   - **Option:** removing them from history means a history rewrite and a force-push, which every teammate has to re-clone after.
   - **Backups:** local copies are in `/home/perry/waspada-removed-files-2026-11-27/`.
6. **Full visual refresh (direction B).** You asked for it on 27 Nov ("awwwards level", minimal, strongly unified). GUI-04 below is the first pass. Two follow-ups are yours to decide:
   - **(a) Basemap. Owner decision (28 Nov 2026): don't grey it out entirely.** The OSM tiles stay with a softer wash (`saturate(0.5)` in both themes; dark is inverted), so water, parks and main roads keep muted colour and the pins stay the strongest colour. Earlier option, not taken: The map now washes the OpenStreetMap tiles to greyscale. A purpose-built quiet basemap (for example CARTO Positron / Dark Matter) would look cleaner. That means adding a third-party tile host to the CSP and accepting its terms, which are free for non-commercial use with attribution.
   - **(b) Brand mark.** The "WJ" square is now ink-on-paper. A proper logo or wordmark would need your input.
7. **Android release.** The Flutter detail change (fewer claims and versions shown at once) ships only in a new APK. The tag push was blocked for me before. To release, run:
   `git tag mobile-v0.2.1 origin/main && git push origin mobile-v0.2.1`
8. **Not audited yet:**
   - admin and moderator screens, which need the synthetic harness and a local build;
   - Android on a real device.

## What was changed (direction A, no visual-language change)

| Area | Change | Audit finding |
|---|---|---|
| Event detail (web) | Shows 3 claims, with the rest behind "Tampilkan N klaim lainnya". History is newest first, 3 versions shown, the rest behind "Lihat N versi sebelumnya", in a slim timeline instead of cards. Secondary time rows (publication, load, fetch) moved into one disclosure; they stay separate rows, as the invariant requires. Removed the "Proyeksi publik" and "Data API" labels. The unknown claim time is no longer repeated on every claim. A missing impact is one muted line instead of a boxed panel. | #1, #9 |
| Event detail (Android) | Same 3 + 3 rule with one expand button each. Newest version first. | #1 |
| Map | Pins drawn about 40% larger with a stronger halo and shadow. Facility pins fade back until hovered. | #3 |
| List cards | Flat cards with no shadow. Titles stop at 3 lines. The unknown-place line is dropped, so the "Tanpa titik"/"Belum dipetakan" badge says it once. The two time facts sit on one line. | #4 |
| Phone overlays | The legend is just its three dots; its title stays for screen readers. The 24-hour caption drops the hidden-count, which the list still shows. Footer and caption lose their shadows. The status trigger is a bare dot, not a filled circle. | #6, #8 |
| Shared links | When a link to an older report widens the map to every report, the map now says so: "Semua laporan ditampilkan karena tautan ini menunjuk laporan lama." | #7 |
| Area saya | Order is now: places, then categories, then one "Minat lain" disclosure for services, institutions and audiences (open if any is filled), then actions, briefing, notifications, and the privacy note as a quiet closing line. Per-field "0/30 · 128 karakter" lines and empty boxes are gone; the count shows once a value exists. "Kontrak briefing" wording removed. | #5 |
| Small copy | Plainer Pembaruan lead. The `#unduh` disclosure has an arrow. | #11, #12 |

Every change keeps the invariants:
- no radius, polygon or invented point;
- events without a location aren't pinned;
- no "aman" wording;
- times kept separate;
- every claim and version still on the page (collapsed, not removed).

## GUI-04 (27 Nov 2026): unified design layer "Tenang"

You asked for a full visual refresh (direction B) on 27 Nov: minimal, uncluttered, strongly unified. All of it lives in one stylesheet, `apps/web/src/design/v4.css`, which loads last. Its rules sit under `html`, so the lazily loaded admin CSS cannot override them.

| Part | What changed |
|---|---|
| Palette | Neutral ink-on-paper in both themes. Teal only for things you can act on. Red only for incidents and errors. "Subtle" text is darkened to pass WCAG AA. |
| Surfaces | Flat, 1px hairline, one radius scale (6/10/14). No glass blur anywhere. Shadow only on things that float. |
| Controls | Every button family uses the same height, radius and weight: `.button`, `.admin-button`, `.action-button`, `.modal-btn`, `.experience-action`, map and 3D buttons. Inputs, badges and chips are unified the same way. |
| Labels | Small caps in grey, never coloured. |
| Map | Greyscale washed basemap on every map, including the admin source map. The pins are the only colour, and the selected ring is ink. The list is hairline rows instead of cards. On phones the legend leaves the map (the list and popup name each level) and the footer links move to the menu. |
| Sign-in | One centred card with Masuk/Daftar tabs (accessible tablist, arrow keys). Registration starts hidden. "Lanjutkan tanpa akun" and the intro are one quiet line. The title is shorter and centred. |
| Admin | Quiet top bar (the per-tab shortcut no longer uses the accent). Segmented Contoh/Data switch. The read-only line is said once, not three times. Layer cards drop the five repeated "not public" notes and the "ID" prefix. Moderator copy is plain ("Moderasi · Tinjau bukti"), with no "L4" or "MOD-01". Moderation buttons are styled (Ajukan koreksi, then a danger-quiet Tarik peristiwa). |

**Checks run locally:**
- web typecheck;
- tests for accounts, auth-reset-ui, admin-dashboard, admin-workspace, admin-monitoring, moderator-review, published-event-moderation, fix-mod-ui, experience, ui, source-approval and admin-map: all pass;
- admin screenshots from the synthetic harness (`tools/gui/admin-shots.ts`).

The a11y audit runs in CI.
