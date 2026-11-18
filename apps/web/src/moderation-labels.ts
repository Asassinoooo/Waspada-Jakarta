import { formatDate, formatInstant } from "./display.js";

/**
 * HOSTED-34: Indonesian labels for the codes a moderator sees (triage, discrepancy kinds, event-time precision).
 * A code this build does not know reads "lainnya", never the raw code. The raw code stays in a title attribute where
 * the screen shows it, so a moderator can still match it to the logs.
 */

const OTHER_LABEL = "lainnya";

type LabelMap = Readonly<Record<string, string>>;

const TRIAGE_DISPOSITION_LABELS: LabelMap = {
  ingest: "diproses",
  drop: "dibuang",
  uncertain: "belum pasti",
};

const TRIAGE_JAKARTA_SCOPE_LABELS: LabelMap = {
  dki_jakarta: "DKI Jakarta",
  direct_jakarta_impact: "berdampak langsung ke Jakarta",
  outside_scope: "di luar cakupan",
  unknown: "belum diketahui",
};

const TRIAGE_ACTIONABILITY_LABELS: LabelMap = {
  immediate: "segera",
  actionable: "dapat ditindaklanjuti",
  context_only: "hanya konteks",
  none: "tidak perlu tindakan",
  unknown: "belum diketahui",
};

const TRIAGE_CONFIDENCE_LABELS: LabelMap = {
  high: "tinggi",
  medium: "sedang",
  low: "rendah",
};

const TRIAGE_MODEL_STATUS_LABELS: LabelMap = {
  ok: "berhasil",
  provider_error: "galat penyedia",
  invalid_model_output: "keluaran model tidak valid",
  skipped_stage_a: "dilewati aturan",
  not_cleared: "sumber belum disetujui",
  rate_limited: "limit laju, ditunda",
};

/** Every reason code the triage service can write (apps/worker/src/layers/l1-data-knowledge/news-triage.ts). */
const TRIAGE_REASON_LABELS: LabelMap = {
  invalid_entry: "entri tidak valid",
  missing_identity: "identitas item hilang",
  stale_item: "item lama",
  duplicate_item: "item duplikat",
  source_not_cleared: "sumber belum disetujui",
  outside_scope: "di luar cakupan",
  non_actionable: "tidak dapat ditindaklanjuti",
  ambiguous_location: "lokasi belum jelas",
  ambiguous_category: "kategori belum jelas",
  vague_report: "laporan belum jelas",
  conflicting_evidence: "bukti saling bertentangan",
  provider_error: "galat penyedia",
  invalid_model_output: "keluaran model tidak valid",
  retention_not_permitted: "penyimpanan teks tidak diizinkan",
  provider_context_only_exception: "pengecualian konteks saja",
  triage_v1_ingest: "lolos triase",
  triage_v1_stage_a: "lolos aturan awal",
};

const DISCREPANCY_KIND_LABELS: LabelMap = {
  water_depth: "ketinggian air",
  severity_assessment: "penilaian keparahan",
  casualty_count: "jumlah korban",
  operational_status: "status operasional",
};

const EVENT_TIME_PRECISION_LABELS: LabelMap = {
  exact: "jam tercatat",
  date: "tanggal saja",
  range: "rentang",
  unknown: "tidak disebutkan",
};

function labelFrom(map: LabelMap, code: string | null | undefined): string {
  if (code === null || code === undefined) return OTHER_LABEL;
  return Object.prototype.hasOwnProperty.call(map, code) ? map[code]! : OTHER_LABEL;
}

export function triageDispositionLabel(code: string | null | undefined): string {
  return labelFrom(TRIAGE_DISPOSITION_LABELS, code);
}

export function triageJakartaScopeLabel(code: string | null | undefined): string {
  return labelFrom(TRIAGE_JAKARTA_SCOPE_LABELS, code);
}

export function triageActionabilityLabel(code: string | null | undefined): string {
  return labelFrom(TRIAGE_ACTIONABILITY_LABELS, code);
}

export function triageConfidenceLabel(code: string | null | undefined): string {
  return labelFrom(TRIAGE_CONFIDENCE_LABELS, code);
}

export function triageModelStatusLabel(code: string | null | undefined): string {
  return labelFrom(TRIAGE_MODEL_STATUS_LABELS, code);
}

export function triageReasonLabel(code: string | null | undefined): string {
  return labelFrom(TRIAGE_REASON_LABELS, code);
}

export function discrepancyKindLabel(kind: string | null | undefined): string {
  return labelFrom(DISCREPANCY_KIND_LABELS, kind);
}

export function eventTimePrecisionLabel(precision: string | null | undefined): string {
  return labelFrom(EVENT_TIME_PRECISION_LABELS, precision);
}

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T/u;

/**
 * An event time on the moderator screens. A calendar day shows the date only, with no clock time. An instant shows in
 * Jakarta time. A clock-time range from the report text is shown as written. Unknown time or no value reads "tidak disebutkan".
 */
export function proposalEventTimeText(time: { readonly precision: string | null | undefined; readonly value: string | null }): string {
  if (time.precision === "unknown" || time.precision === undefined || time.precision === null || !time.value) {
    return eventTimePrecisionLabel("unknown");
  }
  const value = time.value;
  if (CALENDAR_DAY.test(value)) return `${formatDate(`${value}T00:00:00+07:00`)} (${eventTimePrecisionLabel(time.precision)})`;
  if (INSTANT.test(value) && !Number.isNaN(Date.parse(value))) return `${formatInstant(value)} (${eventTimePrecisionLabel(time.precision)})`;
  return `${value} (${eventTimePrecisionLabel(time.precision)})`;
}
