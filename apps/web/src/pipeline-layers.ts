/**
 * Shared Indonesian names for the five pipeline layers. The admin dashboard (`#admin`) and the
 * moderator flow view (`#alur-agen`) both import these, so one layer has one name everywhere.
 */
export type PipelineLayerId = "L1" | "L2" | "L3" | "L4" | "L5";

export const PIPELINE_LAYER_IDS: readonly PipelineLayerId[] = ["L1", "L2", "L3", "L4", "L5"];

export const PIPELINE_LAYER_NAMES: Readonly<Record<PipelineLayerId, string>> = {
  L1: "Penerimaan laporan",
  L2: "Pencarian bukti",
  L3: "Pemeriksaan lanjutan",
  L4: "Tinjauan laporan",
  L5: "Pemantauan sistem",
};

export const PIPELINE_LAYER_SHORT_NAMES: Readonly<Record<PipelineLayerId, string>> = {
  L1: "Terima",
  L2: "Cari bukti",
  L3: "Periksa",
  L4: "Tinjau",
  L5: "Pantau",
};
