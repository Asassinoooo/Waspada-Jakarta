import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SiteHeader } from "../src/AppShell.js";

/** The text of one `@media (max-width: <width>)` block in app-shell.css, found by matching its braces. */
function mediaBlock(css: string, width: string): string {
  const start = css.indexOf(`@media (max-width: ${width}) {`);
  assert.notEqual(start, -1, `app-shell.css has a max-width: ${width} block`);
  let depth = 0;
  for (let index = css.indexOf("{", start); index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, index + 1);
    }
  }
  assert.fail(`the max-width: ${width} block is not closed`);
}

const css = readFileSync(new URL("../src/app-shell.css", import.meta.url), "utf8");

test("from 601px to 900px the header gaps tighten and the nav scrolls inside itself, so no item is drawn behind the badge", () => {
  const tablet = mediaBlock(css, "900px");
  assert.match(tablet, /\.site-header\s*\{[^}]*column-gap:\s*var\(--space-3\)/u);
  assert.match(tablet, /\.primary-nav\s*\{[^}]*overflow-x:\s*auto/u, "the nav is the last fallback: it scrolls, it never overlaps");
  assert.match(tablet, /\.primary-nav a\s*\{\s*padding:\s*0 var\(--space-2\);\s*\}/u);
  assert.match(tablet, /\.site-header__badge,\s*\.site-header__account\s*\{\s*padding-inline:\s*var\(--space-2\);\s*\}/u);
  assert.doesNotMatch(tablet, /site-header__badge-label|primary-nav a[^{]*\{[^}]*display:\s*none/u, "the dataset label and nav text stay visible at tablet widths");
});

test("below 768px the brand name is hidden and the brand mark keeps its link and accessible name", () => {
  const narrow = mediaBlock(css, "768px");
  // A11Y-01: hidden visually only. display:none would drop the link's only name at phone width (axe link-name).
  assert.match(narrow, /\.brand__text\s*\{[^}]*position:\s*absolute;[^}]*clip:\s*rect\(0 0 0 0\);[^}]*\}/u);
  assert.doesNotMatch(css, /\.brand__text\s*\{\s*display:\s*none/u);

  const markup = renderToStaticMarkup(createElement(SiteHeader, { route: { screen: "discover" }, context: null }));
  // A11Y-01: the brand link's accessible name is its visible text (axe label-content-name-mismatch).
  assert.match(markup, /<a class="brand" href="#peta"[ >]/u);
  const navLabels = [...markup.matchAll(/<nav class="primary-nav"[\s\S]*?<\/nav>/gu)][0]?.[0].match(/<span>([^<]+)<\/span>/gu) ?? [];
  assert.deepEqual(navLabels, ["<span>Peta</span>", "<span>Pembaruan</span>", "<span>Area saya</span>"]);
  assert.match(markup, /class="site-header__badge-label">Status data</u, "the dataset label is in the header markup");
});

test("BRAND-01: the header brand mark is the Tugu logo, decorative, with its teal flame and no WJ text", () => {
  const markup = renderToStaticMarkup(createElement(SiteHeader, { route: { screen: "discover" }, context: null }));
  const mark = markup.match(/<span class="brand-mark"[^>]*>([\s\S]*?)<\/span>/u);
  assert.ok(mark, "brand mark present");
  assert.match(mark[0], /aria-hidden="true"/u);
  assert.match(mark[1], /<svg class="brand-mark__svg" viewBox="0 0 64 64"/u);
  assert.match(mark[1], /class="brand-mark__flame"/u);
  assert.doesNotMatch(mark[1], /WJ/u);
  assert.match(markup, /Waspada Jakarta/u, "the visible or accessible name stays text");
  const favicon = readFileSync(new URL("../public/favicon.svg", import.meta.url), "utf8");
  assert.match(favicon, /prefers-color-scheme: dark/u);
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<link rel="icon" href="\/favicon.svg" type="image\/svg\+xml" \/>/u);
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon.png" \/>/u);
});
