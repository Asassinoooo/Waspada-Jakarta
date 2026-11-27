/**
 * SEC-HEADERS-01 (NFR-07): the static site's security headers live in public/_headers, which Vite copies to
 * dist/_headers and Cloudflare static assets applies. These checks read the file and the source it must match.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const headersFile = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
const lines = headersFile.split("\n");

/** The indented header lines that follow the `/*` rule (Cloudflare _headers format). */
function headerValue(name: string): string {
  const prefix = `  ${name}: `;
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  assert.ok(line, `${name} is set under the /* rule`);
  return line.slice(prefix.length);
}

const CSP = headerValue("Content-Security-Policy");
const cspDirectives = new Map(
  CSP.split(";").map((part) => part.trim()).filter((part) => part.length > 0).map((part) => {
    const [name, ...sources] = part.split(/\s+/u);
    return [name!, sources.join(" ")] as const;
  }),
);

// UI-V3: hashed build assets and the self-hosted font are immutable, so they get their own long-cache rules.
const extraRules = new Set(["/assets/*", "/fonts/*"]);

test("_headers opens with the /* rule at column 0 and every header line is indented", () => {
  assert.equal(lines[0], "/*");
  for (const line of lines.slice(1).filter((candidate) => candidate.trim().length > 0)) {
    if (extraRules.has(line)) continue;
    assert.match(line, /^ {2}\S/u, `indented header line: ${line}`);
  }
});

test("UI-V3: hashed assets and fonts are cached for a year as immutable", () => {
  for (const rule of extraRules) {
    const index = lines.indexOf(rule);
    assert.ok(index > 0, `${rule} rule exists`);
    assert.equal(lines[index + 1], "  Cache-Control: public, max-age=31536000, immutable");
  }
});

test("the Content-Security-Policy has every required directive with its source list", () => {
  assert.equal(cspDirectives.get("default-src"), "'self'");
  assert.equal(cspDirectives.get("script-src"), "'self'");
  assert.equal(cspDirectives.get("style-src"), "'self'");
  assert.equal(cspDirectives.get("img-src"), "'self' data: https://tile.openstreetmap.org");
  assert.equal(cspDirectives.get("connect-src"), "'self'");
  assert.equal(cspDirectives.get("font-src"), "'self'");
  assert.equal(cspDirectives.get("object-src"), "'none'");
  assert.equal(cspDirectives.get("base-uri"), "'self'");
  assert.equal(cspDirectives.get("form-action"), "'self'");
  assert.equal(cspDirectives.get("frame-ancestors"), "'none'");
  assert.equal(cspDirectives.has("upgrade-insecure-requests"), true);
});

test("the CSP does not allow unsafe inline scripts or styles", () => {
  assert.doesNotMatch(CSP, /unsafe-inline|unsafe-eval/u);
});

test("the img-src allows the OpenStreetMap tile host that the map sources use", () => {
  const imgSources = cspDirectives.get("img-src")!.split(" ");
  assert.ok(imgSources.includes("https://tile.openstreetmap.org"));

  const srcDir = new URL("../src/", import.meta.url);
  const tileHosts = new Set<string>();
  for (const file of readdirSync(srcDir)) {
    if (!/\.(?:ts|tsx)$/u.test(file)) continue;
    const text = readFileSync(new URL(file, srcDir), "utf8");
    for (const match of text.matchAll(/https:\/\/(tile\.[a-z.]+)\//gu)) tileHosts.add(match[1]!);
  }
  assert.ok(tileHosts.size > 0, "the map sources name at least one tile template");
  for (const host of tileHosts) {
    assert.ok(imgSources.includes(`https://${host}`), `img-src allows tile host ${host}`);
  }
});

test("the other security headers are set to the required values", () => {
  assert.equal(headerValue("Strict-Transport-Security"), "max-age=31536000; includeSubDomains");
  assert.equal(headerValue("X-Content-Type-Options"), "nosniff");
  assert.equal(headerValue("X-Frame-Options"), "DENY");
  assert.equal(headerValue("Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.equal(headerValue("Permissions-Policy"), "camera=(), microphone=(), geolocation=()");
});

test("the Permissions-Policy grants geolocation only when the app reads it", () => {
  const srcDir = new URL("../src/", import.meta.url);
  for (const file of readdirSync(srcDir)) {
    if (!/\.(?:ts|tsx)$/u.test(file)) continue;
    const text = readFileSync(new URL(file, srcDir), "utf8");
    assert.doesNotMatch(text, /navigator\.geolocation/u, `${file} must not read geolocation while it is denied`);
  }
});

test("every _headers line stays under Cloudflare's 2000-character line limit", () => {
  for (const line of lines) assert.ok(line.length < 2000, "a line is under 2000 characters");
});
