import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HistoryChange } from "@waspada/worker/public-contracts";
import { HistoryChanges, historyChangeRows } from "../src/history-changes.js";

/** HIST-UI-01: "Lihat perubahan" shows what changed from the previous published version. */

const changes: HistoryChange[] = [
  { field: "title", before: "Banjir di Kemang", after: "Banjir surut sebagian di Kemang" },
  { field: "lifecycle", before: "ongoing", after: "resolved" },
  { field: "freshness", before: "current", after: "needs_update" },
  { field: "category", before: "flooding", after: "other" },
  { field: "event_time", before: null, after: "date 2026-11-20T00:00:00.000Z -" },
  { field: "validity", before: null, after: "- 2026-11-21T10:00:00.000Z" },
  { field: "places", added: ["Kemang"], removed: ["Mampang"] },
  { field: "claims", before_count: 2, after_count: 3 },
];

function render(value: HistoryChange[] | undefined): string {
  return renderToStaticMarkup(createElement(HistoryChanges, { changes: value }));
}

test("no disclosure without changes (version 1 or retracted)", () => {
  assert.equal(render(undefined), "");
  assert.equal(render([]), "");
});

test("renders a closed native disclosure with one row per change", () => {
  const html = render(changes);
  assert.match(html, /^<details class="history-changes">/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /<summary>Lihat perubahan/);
  assert.equal((html.match(/class="history-changes__row"/g) ?? []).length, changes.length);
});

test("text, lifecycle and freshness use plain labels with before and after", () => {
  const html = render(changes);
  assert.match(html, /<del><span class="visually-hidden">Sebelum: <\/span>Banjir di Kemang<\/del>/);
  assert.match(html, /<ins><span class="visually-hidden">Sesudah: <\/span>Banjir surut sebagian di Kemang<\/ins>/);
  assert.match(html, />Berlangsung<\/del>/);
  assert.match(html, />Selesai<\/ins>/);
  assert.match(html, />Perlu diperbarui<\/ins>/);
  assert.doesNotMatch(html, /fixture/i);
});

test("place chips mark additions and removals", () => {
  const html = render(changes);
  assert.match(html, /history-chip--added[^>]*>.*Ditambahkan: <\/span>Kemang/);
  assert.match(html, /history-chip--removed[^>]*>.*Dihapus: <\/span>Mampang/);
});

test("claim counts and missing values read in Indonesian", () => {
  const rows = historyChangeRows(changes);
  const claims = rows.find((row) => row.field === "claims");
  assert.deepEqual(claims && claims.kind === "count" ? [claims.before, claims.after] : null, [2, 3]);
  const html = render(changes);
  assert.match(html, />2 klaim<\/del>/);
  assert.match(html, />3 klaim<\/ins>/);
  assert.match(html, /Tidak ada masa berlaku dari sumber/);
  assert.match(html, /Sampai /);
});

test("never implies safety", () => {
  assert.doesNotMatch(render(changes), /\baman\b/i);
});
