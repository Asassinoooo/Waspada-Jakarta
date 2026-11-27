import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { routeFromHash } from "../src/App.js";
import {
  DownloadPage,
  type LoadState,
  formatMegabytes,
  loadMobileRelease,
  parseMobileRelease,
} from "../src/DownloadPage.js";

/** MOBILE-REL-01: `#unduh` reads the committed release manifest and links only to this project's GitHub Release. */

const manifest = JSON.parse(readFileSync(new URL("../public/mobile-release.json", import.meta.url), "utf8")) as unknown;

function release() {
  const parsed = parseMobileRelease(manifest);
  assert.ok(parsed, "committed mobile-release.json parses");
  return parsed;
}

function html(state: LoadState) {
  return renderToStaticMarkup(createElement(DownloadPage, { initialState: state }));
}

test("#unduh routes to the download screen", () => {
  assert.deepEqual(routeFromHash("#unduh"), { screen: "download" });
});

test("the committed manifest parses with arm64 first", () => {
  const parsed = release();
  assert.equal(parsed.files[0]?.abi, "arm64-v8a");
  for (const file of parsed.files) {
    assert.ok(file.url.startsWith("https://github.com/Asassinoooo/Waspada-Jakarta/releases/download/"));
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
  }
});

test("rejects links outside the project's GitHub Release and bad hashes", () => {
  const base = manifest as { files: Record<string, unknown>[] } & Record<string, unknown>;
  const file = base.files[0]!;
  assert.equal(parseMobileRelease({ ...base, files: [{ ...file, url: "https://evil.example/" + String(file.name) }] }), null);
  assert.equal(parseMobileRelease({ ...base, files: [{ ...file, sha256: "abc" }] }), null);
  assert.equal(parseMobileRelease({ ...base, release_url: "https://evil.example/" }), null);
  assert.equal(parseMobileRelease({ ...base, files: [] }), null);
  assert.equal(parseMobileRelease(null), null);
});

test("loaded page shows version, primary download, other files and hashes", () => {
  const parsed = release();
  const page = html({ status: "loaded", release: parsed });
  assert.match(page, new RegExp(`Versi ${parsed.version.replaceAll(".", "\\.")}`));
  assert.match(page, /class="button button--primary download-file__button" href="https:\/\/github\.com\/Asassinoooo\/Waspada-Jakarta\/releases\/download\/[^"]+arm64-v8a\.apk"/);
  assert.match(page, new RegExp(`Unduh APK · ${formatMegabytes(parsed.files[0]!.sizeBytes).replace(".", "\\.")}`));
  assert.match(page, /File untuk perangkat lain \(2\)/);
  assert.equal((page.match(/download-file__sha"/g) ?? []).length, parsed.files.length);
  assert.equal((page.match(/class="button button--primary/g) ?? []).length, 1, "one primary action");
});

test("missing and unavailable states", () => {
  assert.match(html({ status: "missing" }), /Belum ada rilis\./);
  assert.match(html({ status: "unavailable" }), /role="alert"/);
});

test("install guide, emergency notice and privacy note; never implies safety", () => {
  const page = html({ status: "missing" });
  assert.match(page, /Izinkan dari sumber ini/);
  assert.match(page, /Bukan aplikasi darurat\./);
  assert.match(page, /href="tel:112"/);
  assert.match(page, /disimpan di HP Anda/);
  assert.doesNotMatch(page, /\baman\b/i);
});

test("loader maps 404 and invalid JSON to missing, network errors to unavailable", async () => {
  const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  assert.deepEqual(await loadMobileRelease(respond(404, {})), { status: "missing" });
  assert.deepEqual(await loadMobileRelease(respond(200, { nope: true })), { status: "missing" });
  assert.deepEqual(await loadMobileRelease(respond(500, {})), { status: "unavailable" });
  assert.deepEqual(await loadMobileRelease((async () => { throw new Error("offline"); }) as typeof fetch), { status: "unavailable" });
  const ok = await loadMobileRelease(respond(200, manifest));
  assert.equal(ok.status, "loaded");
});
