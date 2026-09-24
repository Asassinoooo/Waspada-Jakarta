import type { EventView, FreshnessStatus, Lifecycle } from "@waspada/worker/public-contracts";

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

export function formatEventTime(event: Pick<EventView, "event_time">) {
  const time = event.event_time;
  if (time.precision === "unknown" || !time.start) return "Waktu kejadian tidak diketahui";
  const value = time.precision === "date" ? formatDate(time.start) : formatInstant(time.start);
  if (time.end) {
    const end = time.precision === "date" ? formatDate(time.end) : formatInstant(time.end);
    return value + " sampai " + end + " (" + precisionLabel(time.precision) + ")";
  }
  return value + " (" + precisionLabel(time.precision) + ")";
}

export function precisionLabel(value: "exact" | "date" | "range" | "unknown") {
  switch (value) {
    case "exact":
      return "waktu tepat menurut fixture";
    case "date":
      return "tanggal saja";
    case "range":
      return "rentang waktu";
    case "unknown":
      return "tidak diketahui";
  }
}

export function lifecycleLabel(value: Lifecycle) {
  switch (value) {
    case "planned":
      return "Direncanakan";
    case "ongoing":
      return "Berlangsung (nilai fixture)";
    case "resolved":
      return "Selesai";
    case "cancelled":
      return "Dibatalkan";
    case "unknown":
      return "Belum diketahui";
  }
}

export function freshnessLabel(value: FreshnessStatus) {
  switch (value) {
    case "current":
      return "Dalam batas tinjau saat evaluasi fixture";
    case "needs_update":
      return "Perlu diperbarui";
    case "expired":
      return "Lewat batas tinjau";
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
    default:
      return value;
  }
}
