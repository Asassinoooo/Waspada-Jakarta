import { UPDATE_CURSOR_STORAGE_KEY } from "./UpdatesCenter.js";
import {
  PREFERENCES_STORAGE_KEY,
  type PreferencesStorage,
} from "./preferences-store.js";

export const WASPADA_LOCAL_DATA_ITEMS = [
  {
    id: "preferences",
    key: PREFERENCES_STORAGE_KEY,
    label: "Minat tersimpan",
    description: "Tempat, layanan, institusi, kelompok, dan kategori yang Anda pilih.",
  },
  {
    id: "updateCursor",
    key: UPDATE_CURSOR_STORAGE_KEY,
    label: "Kursor pembaruan",
    description: "Penanda buram untuk melanjutkan pemeriksaan pembaruan. Nilainya tidak ditampilkan.",
  },
] as const;

export type WaspadaLocalDataId = typeof WASPADA_LOCAL_DATA_ITEMS[number]["id"];
export type LocalDataPresence = "present" | "absent" | "unavailable";

export interface WaspadaLocalDataItem {
  id: WaspadaLocalDataId;
  key: string;
  label: string;
  description: string;
  status: LocalDataPresence;
}

export type ClearLocalDataResult = {
  status: "cleared" | "partial" | "failed" | "unavailable";
  items: WaspadaLocalDataItem[];
  attempted: WaspadaLocalDataId[];
};

function unavailableItems(): WaspadaLocalDataItem[] {
  return WASPADA_LOCAL_DATA_ITEMS.map((item) => ({ ...item, status: "unavailable" }));
}

export function inspectWaspadaLocalData(
  storage: PreferencesStorage | null | undefined,
): WaspadaLocalDataItem[] {
  if (!storage) return unavailableItems();

  return WASPADA_LOCAL_DATA_ITEMS.map((item) => {
    try {
      return { ...item, status: storage.getItem(item.key) === null ? "absent" : "present" };
    } catch {
      return { ...item, status: "unavailable" };
    }
  });
}

export function clearWaspadaLocalData(
  storage: PreferencesStorage | null | undefined,
): ClearLocalDataResult {
  if (!storage) {
    return { status: "unavailable", items: unavailableItems(), attempted: [] };
  }

  const attempted: WaspadaLocalDataId[] = [];
  const items = WASPADA_LOCAL_DATA_ITEMS.map((item): WaspadaLocalDataItem => {
    let before: string | null | undefined;
    try {
      before = storage.getItem(item.key);
    } catch {
      before = undefined;
    }

    if (before === null) return { ...item, status: "absent" };

    attempted.push(item.id);
    try {
      storage.removeItem(item.key);
    } catch {
      // The verification read below decides whether the value is still present.
    }

    try {
      return { ...item, status: storage.getItem(item.key) === null ? "absent" : "present" };
    } catch {
      return { ...item, status: "unavailable" };
    }
  });

  const absentCount = items.filter((item) => item.status === "absent").length;
  const allUnavailable = items.every((item) => item.status === "unavailable");
  const status = absentCount === items.length
    ? "cleared"
    : absentCount > 0
      ? "partial"
      : allUnavailable
        ? "unavailable"
        : "failed";

  return { status, items, attempted };
}
