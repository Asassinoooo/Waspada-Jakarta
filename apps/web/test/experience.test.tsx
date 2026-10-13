import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PrivacyPage } from "../src/PrivacyPage.js";
import { ReadGuide } from "../src/ReadGuide.js";
import { HelpPage } from "../src/HelpPage.js";
import {
  clearWaspadaLocalData,
  inspectWaspadaLocalData,
  WASPADA_LOCAL_DATA_ITEMS,
} from "../src/privacy-store.js";
import type { PreferencesStorage } from "../src/preferences-store.js";

class MemoryStorage implements PreferencesStorage {
  readonly values = new Map<string, string>();
  readonly failReads = new Set<string>();
  readonly failRemovals = new Set<string>();
  readonly ignoreRemovals = new Set<string>();

  getItem(key: string) {
    if (this.failReads.has(key)) throw new Error("read blocked");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    if (this.failRemovals.has(key)) throw new Error("remove blocked");
    if (!this.ignoreRemovals.has(key)) this.values.delete(key);
  }
}

const [preferencesItem, cursorItem] = WASPADA_LOCAL_DATA_ITEMS;

test("privacy reset clears only the two known Waspada keys and verifies absence", () => {
  const storage = new MemoryStorage();
  storage.values.set(preferencesItem.key, "saved interests");
  storage.values.set(cursorItem.key, "opaque cursor secret");
  storage.values.set("unrelated:site-key", "keep this value");

  const result = clearWaspadaLocalData(storage);

  assert.equal(result.status, "cleared");
  assert.deepEqual(result.attempted, ["preferences", "updateCursor"]);
  assert.deepEqual(result.items.map((item) => item.status), ["absent", "absent"]);
  assert.equal(storage.values.get("unrelated:site-key"), "keep this value");
  assert.equal(storage.values.has(preferencesItem.key), false);
  assert.equal(storage.values.has(cursorItem.key), false);
});

test("privacy reset reports per-key partial failure and preserves unrelated values", () => {
  const storage = new MemoryStorage();
  storage.values.set(preferencesItem.key, "saved interests");
  storage.values.set(cursorItem.key, "opaque cursor secret");
  storage.values.set("unrelated:site-key", "keep this value");
  storage.failRemovals.add(preferencesItem.key);

  const result = clearWaspadaLocalData(storage);

  assert.equal(result.status, "partial");
  assert.deepEqual(result.items.map((item) => item.status), ["present", "absent"]);
  assert.equal(storage.values.get(preferencesItem.key), "saved interests");
  assert.equal(storage.values.has(cursorItem.key), false);
  assert.equal(storage.values.get("unrelated:site-key"), "keep this value");
});

test("privacy reset verifies ignored removals and distinguishes inaccessible storage", () => {
  const storage = new MemoryStorage();
  storage.values.set(preferencesItem.key, "saved interests");
  storage.values.set(cursorItem.key, "opaque cursor secret");
  storage.ignoreRemovals.add(preferencesItem.key);
  storage.failReads.add(cursorItem.key);

  const result = clearWaspadaLocalData(storage);

  assert.equal(result.status, "failed");
  assert.deepEqual(result.items.map((item) => item.status), ["present", "unavailable"]);
  assert.equal(inspectWaspadaLocalData(null).every((item) => item.status === "unavailable"), true);
  assert.equal(clearWaspadaLocalData(null).status, "unavailable");
});

test("read guide renders as skippable Bahasa help with distinct status, time, and map meanings", () => {
  const html = renderToStaticMarkup(<ReadGuide />);

  assert.match(html, /<main id="main-content" tabindex="-1"/u);
  assert.match(html, /Lewati panduan, jelajahi laporan/u);
  assert.match(html, /Status kejadian atau dampak/u);
  assert.match(html, /Kesegaran informasi/u);
  assert.match(html, /Dalam batas tinjau saat evaluasi/u);
  assert.match(html, /Masa berlaku sumber berakhir/u);
  assert.doesNotMatch(html, /Batas tinjau lewat/u);
  assert.match(html, /Dukungan untuk klaim/u);
  assert.match(html, /Mengapa laporan muncul/u);
  assert.match(html, /Waktu sistem mengambil sumber/u);
  assert.match(html, /Titik tidak diperluas menjadi radius bahaya/u);
  assert.match(html, /bukan pernyataan bahwa wilayah aman/u);
  assert.doesNotMatch(html, /Aktifkan notifikasi|Lokasi perangkat/u);
});

test("privacy page lists only known local values and waits for a second confirmation", () => {
  const storage = new MemoryStorage();
  storage.values.set(preferencesItem.key, "private interest value");
  storage.values.set(cursorItem.key, "opaque cursor secret");
  storage.values.set("unrelated:site-key", "keep this value");

  const html = renderToStaticMarkup(<PrivacyPage storage={storage} />);

  assert.match(html, /<main id="main-content" tabindex="-1"/u);
  assert.match(html, /Yang tersimpan di browser/u);
  assert.match(html, /Apa yang dikirim dari browser/u);
  assert.match(html, /tile\.openstreetmap\.org/u);
  assert.match(html, /alamat ubin[\s\S]*area peta yang sedang dilihat, bukan lokasi presisi perangkat/u);
  assert.match(html, /Minat tersimpan tidak disertakan dalam permintaan ubin/u);
  assert.match(html, /href="https:\/\/www\.openstreetmap\.org\/copyright" target="_blank" rel="noreferrer"/u);
  assert.equal((html.match(/href="https?:\/\//gu) ?? []).length, 1);
  assert.match(html, /Tinjau penghapusan data/u);
  assert.doesNotMatch(html, /Ya, hapus data Waspada/u);
  assert.doesNotMatch(html, /private interest value|opaque cursor secret/u);
  assert.match(html, /dikirim saat Anda meminta ringkasan, untuk memenuhi permintaan tersebut/u);
  assert.match(html, /Fitur ringkasan tidak menyimpan data minat yang dikirim/u);
  assert.doesNotMatch(html, /kontrak briefing|mode data persis/u);
  assert.match(html, /log layanan atau hosting tidak dihapus/u);
  assert.match(html, /Penanda pembaruan membantu melanjutkan pemeriksaan/u);
  assert.doesNotMatch(html, /Cursor|cursor|kursor|polling|Penanda teknis/u);
  assert.equal(storage.values.get("unrelated:site-key"), "keep this value");
});

test("combined help keeps one main landmark and section-addressable guide and privacy content", () => {
  const storage = new MemoryStorage();
  storage.values.set(preferencesItem.key, "private interest value");
  const html = renderToStaticMarkup(<HelpPage section="privasi" storage={storage} />);

  assert.equal((html.match(/<main\b/gu) ?? []).length, 1);
  assert.equal((html.match(/id="main-content"/gu) ?? []).length, 1);
  assert.equal((html.match(/id="panduan"/gu) ?? []).length, 1);
  assert.equal((html.match(/id="privasi"/gu) ?? []).length, 1);
  assert.match(html, /href="#privasi" aria-current="location">Data dan privasi/u);
  assert.match(html, /id="panduan" tabindex="-1"[^>]*aria-labelledby="read-guide-title"/u);
  assert.match(html, /id="privasi" tabindex="-1"[^>]*aria-labelledby="privacy-title"/u);
  assert.match(html, /Cara membaca laporan/u);
  assert.match(html, /Data Waspada di browser ini/u);
  assert.match(html, /Tinjau penghapusan data/u);
  assert.doesNotMatch(html, /private interest value/u);
  assert.doesNotMatch(html, /Inspektor proses lokal/u);
  assert.match(html, /href="#admin">Pengelola · demo/u);
  assert.match(html, /href="#tinjau-bukti">Tinjau bukti · demo · baca saja/u);
  assert.match(html, /<h2 id="operator-links-title">Untuk pengelola<\/h2>/u);
  assert.match(html, /Tampilan pengelolaan dan tinjau ini bersifat baca saja/u);

  const serverHelp = renderToStaticMarkup(<HelpPage showLocalPipeline />);
  assert.doesNotMatch(serverHelp, /Inspektor proses lokal|pipeline-lokal/u);
});
