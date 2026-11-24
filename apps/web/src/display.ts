import type { EventView, FreshnessStatus, Lifecycle, PublicContext, TimeScope } from "@waspada/worker/public-contracts";

const instantFormatter = new Intl.DateTimeFormat("id-ID", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Jakarta",
  hourCycle: "h23",
});

const dateFormatter = new Intl.DateTimeFormat("id-ID", {
  dateStyle: "medium",
  timeZone: "Asia/Jakarta",
});

export function formatInstant(value: string | null | undefined) {
  if (!value) return "Tidak tersedia";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Waktu tidak valid";
  return instantFormatter.format(date) + " WIB";
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "Tidak tersedia";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Tanggal tidak valid";
  return dateFormatter.format(date);
}

/** F-11 (owner decision 18 Nov 2026): the one wording for an event time that is not known, on every surface. */
export const UNKNOWN_EVENT_TIME_TEXT = "Waktu kejadian tidak disebutkan";

/** Added after a calendar day. The hour is not known, so none is shown. */
const DATE_ONLY_TIME_NOTE = ", jam tidak disebutkan";

/** A "YYYY-MM-DD" value is a calendar day with no clock time. */
function isCalendarDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

/**
 * The event time (waktu kejadian) as text. Every surface that shows an event time uses this helper.
 * - exact: the instant in Jakarta time, e.g. "17 Nov 2026, 07.00 WIB" (id-ID writes the time with a dot).
 * - date: the day with the hour left out, e.g. "17 Nov 2026, jam tidak disebutkan". An hour is never invented.
 * - range: start – end.
 * - unknown, or no start: UNKNOWN_EVENT_TIME_TEXT.
 * A calendar day is read as its Jakarta midnight, so the day does not move with the host timezone.
 */
export function eventTimeText(time: Pick<TimeScope, "start" | "end" | "precision">): string {
  if (time.precision === "unknown" || !time.start) return UNKNOWN_EVENT_TIME_TEXT;
  const bound = (value: string) => (isCalendarDay(value) ? formatDate(`${value}T00:00:00+07:00`) : formatInstant(value));
  const text = time.end ? `${bound(time.start)} – ${bound(time.end)}` : bound(time.start);
  return time.precision === "date" ? text + DATE_ONLY_TIME_NOTE : text;
}

/** An event's time, through the same helper as eventTimeText. Kept for the admin and feed call sites. */
export function formatEventTime(event: Pick<EventView, "event_time">): string {
  return eventTimeText(event.event_time);
}

export function lifecycleLabel(value: Lifecycle, options: { fixtureWording?: boolean } = {}) {
  const fixture = options.fixtureWording !== false;
  switch (value) {
    case "planned":
      return "Direncanakan";
    case "ongoing":
      return fixture ? "Berlangsung (nilai fixture)" : "Berlangsung";
    case "resolved":
      return "Selesai";
    case "cancelled":
      return "Dibatalkan";
    case "unknown":
      return "Belum diketahui";
  }
}

export function freshnessLabel(value: FreshnessStatus, options: { fixtureWording?: boolean } = {}) {
  const fixture = options.fixtureWording !== false;
  switch (value) {
    case "current":
      return fixture ? "Dalam batas tinjau saat evaluasi fixture" : "Dalam batas tinjau saat evaluasi";
    case "needs_update":
      return "Perlu diperbarui";
    case "expired":
      return "Lewat masa berlaku sumber";
  }
}

export function evidenceLabel(value: string | null | undefined) {
  switch (value) {
    case "issuer_notice":
      return "Pemberitahuan dari penerbit";
    case "attributed_report":
      return "Laporan teratribusi";
    case "independent_corroboration":
      return "Didukung laporan independen";
    case "crowdsourced_observation":
      return "Laporan warga";
    default:
      return "Bukti belum tersedia";
  }
}

export function categoryLabel(value: string) {
  switch (value) {
    case "transport_road_incidents":
      return "Transportasi dan insiden jalan";
    case "group_specific_critical_notices":
      return "Pemberitahuan penting untuk kelompok";
    case "disasters_weather":
      return "Bencana dan cuaca";
    case "demonstrations_public_gatherings":
      return "Demonstrasi dan keramaian publik";
    case "crime_personal_security":
      return "Keamanan pribadi";
    case "crowds_major_events":
      return "Kerumunan dan acara besar";
    case "violence_immediate_threats":
      return "Kekerasan dan ancaman langsung";
    case "fires_infrastructure_hazards":
      return "Kebakaran dan bahaya infrastruktur";
    case "utilities_essential_services":
      return "Utilitas dan layanan penting";
    case "health_environmental_advisories":
      return "Kesehatan dan lingkungan";
    case "other":
      return "Lainnya";
    case "unclassified":
      return "Belum diklasifikasikan";
    default:
      return value;
  }
}

/** HOSTED-34: the basis of a freshness status, in Indonesian. A code this build does not know reads "lainnya", never the raw code. */
export function freshnessBasisLabel(value: string | null | undefined): string {
  switch (value) {
    case "source_validity":
      return "masa berlaku sumber";
    case "fast_observation_review":
      return "tinjauan cepat laporan";
    case "undated_advisory_review":
      return "tinjauan pengumuman tanpa tanggal";
    case "manual_review":
      return "tinjauan manual";
    case "unknown":
      return "belum diketahui";
    default:
      return "lainnya";
  }
}

/** HOSTED-34: the browser tab title. Only the demo dataset is labelled as synthetic; live and unknown modes get the plain name. */
export function documentTitleFor(datasetMode: PublicContext["dataset_mode"] | null | undefined): string {
  return datasetMode === "demo" ? "Waspada Jakarta — demo sintetis" : "Waspada Jakarta";
}
