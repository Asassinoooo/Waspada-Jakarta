import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SiteHeader, routeFromHash } from "../src/App.js";
import { Preferences } from "../src/Preferences.js";
import {
  addInterestValue,
  CATEGORY_VALUES,
  clearPreferences,
  emptyInterests,
  loadPreferences,
  MAX_INTEREST_CHARACTERS,
  MAX_TEXT_INTERESTS,
  normalizeInterests,
  PREFERENCES_STORAGE_KEY,
  savePreferences,
  type PreferencesStorage,
} from "../src/preferences-store.js";

class MemoryStorage implements PreferencesStorage {
  readonly values = new Map<string, string>();
  failRead = false;
  failWrite = false;
  failClear = false;

  getItem(key: string) {
    if (this.failRead) throw new Error("read blocked");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    if (this.failWrite) throw new Error("quota");
    this.values.set(key, value);
  }

  removeItem(key: string) {
    if (this.failClear) throw new Error("clear blocked");
    this.values.delete(key);
  }
}

function emptyInput() {
  return emptyInterests();
}

test("normalizes text values, ignores blanks, and removes normalized duplicates", () => {
  const normalized = normalizeInterests({
    places: ["  Jakarta Pusat  ", "jakarta pusat", "   ", "Cafe\u0301"],
    services: ["  TransJakarta"],
    institutions: [],
    audiences: [],
    categories: ["disasters_weather", "disasters_weather"],
  });

  assert.equal(normalized.ok, true);
  if (!normalized.ok) return;
  assert.deepEqual(normalized.interests.places, ["Jakarta Pusat", "Café"]);
  assert.deepEqual(normalized.interests.services, ["TransJakarta"]);
  assert.deepEqual(normalized.interests.categories, ["disasters_weather"]);
});

test("counts Unicode code points and does not truncate an overlong value", () => {
  const accepted = "🌧".repeat(MAX_INTEREST_CHARACTERS);
  const rejected = accepted + "🌧";
  assert.equal(addInterestValue([], accepted).status, "added");
  assert.equal(addInterestValue([], rejected).status, "too-long");
  assert.equal(addInterestValue([], rejected).values.length, 0);
});

test("enforces the 30-value limit without silently truncating", () => {
  const values = Array.from({ length: MAX_TEXT_INTERESTS }, (_, index) => "Tempat " + index);
  const result = addInterestValue(values, "Tempat tambahan");
  assert.equal(result.status, "too-many");
  assert.equal(result.values.length, MAX_TEXT_INTERESTS);
  const invalid = normalizeInterests({
    places: [...values, "Tempat tambahan"],
    services: [],
    institutions: [],
    audiences: [],
    categories: [],
  });
  assert.deepEqual(invalid, { ok: false, field: "places", issue: "too-many" });
});

test("save and reload use the versioned browser-local key and normalized request fields", () => {
  const storage = new MemoryStorage();
  const saved = savePreferences(storage, {
    places: ["  Jakarta Pusat  ", "jakarta pusat"],
    services: [],
    institutions: ["Kampus A"],
    audiences: ["mahasiswa"],
    categories: ["disasters_weather"],
  });

  assert.equal(saved.status, "saved");
  assert.equal(storage.values.size, 1);
  assert.deepEqual(JSON.parse(storage.values.get(PREFERENCES_STORAGE_KEY) ?? "null"), {
    version: 1,
    interests: {
      places: ["Jakarta Pusat"],
      services: [],
      institutions: ["Kampus A"],
      audiences: ["mahasiswa"],
      categories: ["disasters_weather"],
    },
  });
  assert.deepEqual(loadPreferences(storage), {
    status: "loaded",
    interests: {
      places: ["Jakarta Pusat"],
      services: [],
      institutions: ["Kampus A"],
      audiences: ["mahasiswa"],
      categories: ["disasters_weather"],
    },
  });
});

test("malformed or out-of-contract saved content is preserved for deliberate recovery", () => {
  const storage = new MemoryStorage();
  storage.values.set(PREFERENCES_STORAGE_KEY, "{not-json");
  assert.deepEqual(loadPreferences(storage), { status: "malformed", issue: "invalid-json" });
  assert.equal(storage.values.get(PREFERENCES_STORAGE_KEY), "{not-json");

  storage.values.set(PREFERENCES_STORAGE_KEY, JSON.stringify({
    version: 1,
    interests: {
      places: ["x".repeat(MAX_INTEREST_CHARACTERS + 1)],
      services: [],
      institutions: [],
      audiences: [],
      categories: [],
    },
  }));
  assert.deepEqual(loadPreferences(storage), { status: "malformed", issue: "invalid-shape" });
  assert.equal(clearPreferences(storage).status, "cleared");
  assert.equal(storage.values.has(PREFERENCES_STORAGE_KEY), false);
});

test("read, write, and clear storage failures return recoverable states", () => {
  const storage = new MemoryStorage();
  storage.failRead = true;
  assert.deepEqual(loadPreferences(storage), { status: "unavailable", operation: "read" });

  storage.failRead = false;
  storage.failWrite = true;
  assert.deepEqual(savePreferences(storage, emptyInput()), { status: "unavailable", operation: "write" });

  storage.failClear = true;
  assert.deepEqual(clearPreferences(storage), { status: "unavailable", operation: "clear" });
});

test("empty preferences render a labelled editor and all ten contract categories", () => {
  const storage = new MemoryStorage();
  const markup = renderToStaticMarkup(<Preferences storage={storage} />);

  assert.match(markup, /Ringkasan saya/);
  assert.match(markup, /name="places"/);
  assert.match(markup, /name="services"/);
  assert.match(markup, /name="institutions"/);
  assert.match(markup, /name="audiences"/);
  assert.equal((markup.match(/name="categories"/g) ?? []).length, CATEGORY_VALUES.length);
  for (const category of CATEGORY_VALUES) assert.match(markup, new RegExp('value="' + category + '"'));
  assert.match(markup, /Minat tetap di browser ini/);
  assert.match(markup, /Menghapus data browser juga menghapus minat tersimpan/);
  assert.match(markup, /Briefing dan pembaruan belum terhubung/);
  assert.match(markup, /keadaan ini tidak menunjukkan bahwa semua area aman/);
  assert.match(markup, /Simpan di perangkat ini/);
  assert.match(markup, /Hapus semua minat/);
});

test("saved preferences render their values without claiming a relevance match", () => {
  const storage = new MemoryStorage();
  savePreferences(storage, {
    places: ["Jakarta Selatan"],
    services: ["TransJakarta"],
    institutions: [],
    audiences: ["mahasiswa"],
    categories: ["transport_road_incidents"],
  });

  const markup = renderToStaticMarkup(<Preferences storage={storage} />);
  assert.match(markup, /Jakarta Selatan/);
  assert.match(markup, /TransJakarta/);
  assert.match(markup, /mahasiswa/);
  assert.match(markup, /Minat yang tersimpan di browser ini telah dimuat/);
  assert.match(markup, /Record contoh di Jelajah tidak digunakan sebagai kecocokan/);
  assert.match(markup, /Tidak dinilai/);
});

test("invalid saved JSON renders a recovery action without exposing a blank editor to overwrite it", () => {
  const storage = new MemoryStorage();
  storage.values.set(PREFERENCES_STORAGE_KEY, "{not-json");

  const markup = renderToStaticMarkup(<Preferences storage={storage} />);
  assert.match(markup, /role="alert"/);
  assert.match(markup, /Data minat tersimpan tidak dapat dibaca/);
  assert.match(markup, /Hapus data minat tersimpan dan mulai lagi/);
  assert.doesNotMatch(markup, /name="places"/);
  assert.doesNotMatch(markup, /Simpan di perangkat ini/);
});

test("unavailable browser storage renders an explanation and keeps editing recoverable", () => {
  const storage = new MemoryStorage();
  storage.failRead = true;

  const markup = renderToStaticMarkup(<Preferences storage={storage} />);
  assert.match(markup, /role="alert"/);
  assert.match(markup, /Penyimpanan browser tidak dapat dibaca/);
  assert.match(markup, /name="places"/);
  assert.match(markup, /Simpan di perangkat ini/);
  assert.match(markup, /Hapus semua minat/);
});

test("preferences have a direct hash route and public navigation link", () => {
  assert.deepEqual(routeFromHash("#ringkasan-saya"), { screen: "preferences" });
  const markup = renderToStaticMarkup(<SiteHeader route={{ screen: "preferences" }} />);
  assert.match(markup, /href="#ringkasan-saya" aria-current="page">Ringkasan saya/);
  assert.match(markup, /DEMO — data sintetis; bukan peringatan langsung/);
});