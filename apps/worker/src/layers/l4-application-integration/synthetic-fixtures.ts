import type { EventView } from "../../contracts/public-api.js";

type SyntheticEventInput = Omit<EventView, "version" | "claims" | "published_at">;

function emptyScope(): EventView["scope"] {
  return {
    places: [],
    services: [],
    institutions: [],
    audiences: [],
  };
}

function syntheticFreshness(
  status: EventView["freshness"]["status"],
  evaluatedAt: string,
  reviewDueAt: string | null,
  basis: EventView["freshness"]["basis"],
): EventView["freshness"] {
  return {
    status,
    evaluated_at: evaluatedAt,
    review_due_at: reviewDueAt,
    basis,
  };
}

function syntheticEvent(event: SyntheticEventInput): EventView {
  return {
    ...event,
    version: 1,
    claims: [],
    published_at: "2026-09-24T00:00:00.000Z",
  };
}

const syntheticTopic = [{ namespace: "topic", value: "synthetic_demo" }] as const;

// These explicitly labelled records are fictional interface examples. They
// contain no source claims, evidence links, real incident locations, or map shapes.
export const syntheticEventFixtures: readonly EventView[] = [
  syntheticEvent({
    event_id: "synthetic-demo-01",
    title: "SIMULASI FIKTIF — Contoh tindak kriminal historis",
    summary:
      "SIMULASI FIKTIF. Contoh kategori keamanan pribadi untuk waktu lampau; seluruh waktu dan status direka, tanpa lokasi, laporan, atau klaim bukti nyata.",
    category: "crime_personal_security",
    tags: [...syntheticTopic],
    lifecycle: "resolved",
    freshness: syntheticFreshness("needs_update", "2026-09-24T00:00:00.000Z", null, "unknown"),
    event_time: { start: "2026-08-20", end: null, precision: "date" },
    validity: { valid_from: null, valid_until: null },
    scope: emptyScope(),
    impacts: [],
  }),
  syntheticEvent({
    event_id: "synthetic-demo-02",
    title: "SIMULASI FIKTIF — Pertemuan publik dan ilustrasi transportasi",
    summary:
      "SIMULASI FIKTIF. Contoh acara terencana beserta dampak transportasi rekaan untuk antarmuka; bukan jadwal, pengalihan, penutupan, atau gangguan nyata. Tidak ada sumber atau klaim bukti.",
    category: "demonstrations_public_gatherings",
    tags: [...syntheticTopic],
    lifecycle: "planned",
    freshness: syntheticFreshness("needs_update", "2026-09-24T00:00:00.000Z", null, "unknown"),
    event_time: {
      start: "2026-10-15T01:00:00.000Z",
      end: "2026-10-15T05:00:00.000Z",
      precision: "range",
    },
    validity: {
      valid_from: "2026-10-15T01:00:00.000Z",
      valid_until: "2026-10-15T05:00:00.000Z",
    },
    scope: emptyScope(),
    impacts: [
      {
        impact_id: "synthetic-impact-demo-02-01",
        version: 1,
        impact_type: "traffic_diversion",
        title: "SIMULASI FIKTIF — Ilustrasi dampak transportasi",
        description:
          "Contoh simulasi untuk tampilan. Bukan laporan pengalihan lalu lintas atau gangguan layanan yang terjadi.",
        lifecycle: "unknown",
        freshness: syntheticFreshness("current", "2026-09-24T00:00:00.000Z", null, "unknown"),
        event_time: {
          start: "2026-10-15T01:00:00.000Z",
          end: "2026-10-15T05:00:00.000Z",
          precision: "range",
        },
        validity: {
          valid_from: "2026-10-15T01:00:00.000Z",
          valid_until: "2026-10-15T05:00:00.000Z",
        },
        scope: emptyScope(),
      },
    ],
  }),
  syntheticEvent({
    event_id: "synthetic-demo-03",
    title: "SIMULASI FIKTIF — Contoh cuaca dan genangan",
    summary:
      "SIMULASI FIKTIF. Skenario cuaca dan genangan yang seluruhnya direka untuk tampilan; bukan peringatan cuaca atau pengamatan banjir nyata. Tidak ada lokasi, sumber, atau klaim bukti.",
    category: "disasters_weather",
    tags: [...syntheticTopic],
    lifecycle: "ongoing",
    freshness: syntheticFreshness("needs_update", "2026-10-09T00:00:00.000Z", null, "unknown"),
    event_time: {
      start: "2026-10-08T02:00:00.000Z",
      end: null,
      precision: "exact",
    },
    validity: { valid_from: "2026-10-08T02:00:00.000Z", valid_until: null },
    scope: emptyScope(),
    impacts: [
      {
        impact_id: "synthetic-impact-demo-03-01",
        version: 1,
        impact_type: "hazard_observation",
        title: "SIMULASI FIKTIF — Ilustrasi pengamatan genangan",
        description:
          "Contoh simulasi untuk tampilan. Bukan pengamatan banjir nyata atau laporan kondisi lapangan.",
        lifecycle: "unknown",
        freshness: syntheticFreshness(
          "current",
          "2026-10-09T00:00:00.000Z",
          "2026-10-09T01:00:00.000Z",
          "fast_observation_review",
        ),
        event_time: { start: "2026-10-08T02:00:00.000Z", end: null, precision: "exact" },
        validity: { valid_from: "2026-10-08T02:00:00.000Z", valid_until: null },
        scope: emptyScope(),
      },
    ],
  }),
  syntheticEvent({
    event_id: "synthetic-demo-04",
    title: "SIMULASI FIKTIF — Pemberitahuan untuk kelompok simulasi",
    summary:
      "SIMULASI FIKTIF. Contoh pemberitahuan rekaan yang hanya ditujukan ke kelompok simulasi; tidak memuat lokasi, layanan, instansi, sumber, atau klaim bukti dan tidak mewakili kondisi nyata.",
    category: "group_specific_critical_notices",
    tags: [...syntheticTopic],
    lifecycle: "unknown",
    freshness: syntheticFreshness("current", "2026-09-24T00:00:00.000Z", null, "unknown"),
    event_time: { start: null, end: null, precision: "unknown" },
    validity: { valid_from: "2026-09-24T00:00:00.000Z", valid_until: "2026-10-24T00:00:00.000Z" },
    scope: {
      places: [],
      services: [],
      institutions: [],
      audiences: ["kelompok-simulasi"],
    },
    impacts: [],
  }),
];
