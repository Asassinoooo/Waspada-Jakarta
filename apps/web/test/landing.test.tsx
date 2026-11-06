import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Landing } from "../src/Landing.js";

test("landing provides direct account-free actions and a captioned illustrative hero", () => {
  const markup = renderToStaticMarkup(<Landing />);

  assert.match(markup, /<main[^>]*tabindex="-1"/);
  assert.match(markup, /Pahami Jakarta sebelum melangkah/);
  assert.match(markup, /href="#jelajah">Jelajahi laporan/);
  assert.match(markup, /href="#ringkasan-saya">Atur minat/);
  assert.match(markup, /Jelajah laporan publik tanpa akun/);
  assert.match(markup, /Ilustrasi Jakarta — bukan peta kejadian/);
  assert.match(markup, /landing-river-reveal/);
});

test("reading guide uses user-controlled instructional panels without verification claims", () => {
  const markup = renderToStaticMarkup(<Landing />);

  assert.match(markup, /aria-label="Pilih topik panduan"/);
  assert.match(markup, /aria-pressed="true" aria-controls="landing-guide-panel">.*?Laporan/s);
  assert.match(markup, /Bukti/);
  assert.match(markup, /Konteks/);
  assert.match(markup, /Mulai dari apa yang dilaporkan/);
  assert.match(markup, /bukan hasil pemeriksaan atau verifikasi otomatis/);
});

test("landing accepts optional props safely without errors", () => {
  const markup = renderToStaticMarkup(
    <Landing
      context={null}
      events={[]}
      status="loaded"
      onRetry={() => {}}
    />
  );

  assert.match(markup, /Pahami Jakarta sebelum melangkah/);
  assert.match(markup, /Mulai dari apa yang dilaporkan/);
});
