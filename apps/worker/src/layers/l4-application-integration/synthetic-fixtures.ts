import type { EventView } from "../../contracts/public-api.js";

const emptyScope = {
  places: [],
  services: [],
  institutions: [],
  audiences: [],
};

const unknownTime = { start: null, end: null, precision: "unknown" as const };
const unknownValidity = { valid_from: null, valid_until: null };

function syntheticEvent(eventId: string, title: string, summary: string): EventView {
  return {
    event_id: eventId,
    version: 1,
    title,
    summary,
    category: "group_specific_critical_notices",
    tags: [{ namespace: "topic", value: "synthetic_demo" }],
    lifecycle: "unknown",
    freshness: {
      status: "needs_update",
      evaluated_at: "2026-09-24T00:00:00.000Z",
      review_due_at: null,
      basis: "unknown",
    },
    event_time: unknownTime,
    validity: unknownValidity,
    scope: emptyScope,
    claims: [],
    impacts: [],
    published_at: "2026-09-24T00:00:00.000Z",
  };
}

// These records are deliberately fictional interface examples. They contain
// no current incident, location, source claim, or safety assessment.
export const syntheticEventFixtures: readonly EventView[] = [
  syntheticEvent(
    "synthetic-demo-01",
    "Contoh fiktif: pemberitahuan kelompok",
    "Data contoh untuk menampilkan bentuk kartu. Ini bukan laporan atau kondisi saat ini.",
  ),
  syntheticEvent(
    "synthetic-demo-02",
    "Contoh fiktif: pengumuman simulasi",
    "Baris sintetis kedua untuk menguji halaman daftar dan paginasi lokal.",
  ),
];
