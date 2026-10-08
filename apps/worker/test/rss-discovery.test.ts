import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRssDiscoveryXml,
  RSS_DISCOVERY_LIMITS,
  type RssDiscoveryParseResult,
} from "../src/layers/l1-data-knowledge/rss-discovery.js";

// Authored synthetic fixtures only. They do not reuse real feed content,
// establish source rights, verify an issuer, prove an event, or establish freshness.
const RETRIEVED_AT = "2001-02-03T14:00:00Z";
const FIXTURE_LABEL = "SYNTHETIC TEST ONLY";
const RSS_OPEN = '<rss version="2.0" xmlns:ext="urn:synthetic:extension" xmlns:content="urn:synthetic:content"><channel>';
const RSS_CLOSE = "</channel></rss>";

function feed(body: string): string {
  return RSS_OPEN + body + RSS_CLOSE;
}

function item(body: string): string {
  return "<item>" + body + "</item>";
}

function parse(xml: string, retrievedAt = RETRIEVED_AT): RssDiscoveryParseResult {
  return parseRssDiscoveryXml(xml, retrievedAt);
}

function errorCode(result: RssDiscoveryParseResult): string {
  assert.equal(result.kind, "error");
  if (result.kind !== "error") throw new Error("expected a bounded parser error");
  assert.deepEqual(Object.keys(result.error), ["code"]);
  assert.ok(!JSON.stringify(result).includes(FIXTURE_LABEL));
  return result.error.code;
}

function exactInputOfBytes(targetBytes: number): string {
  const prefix = "<rss version=\"2.0\"><channel><!--";
  const suffix = "--></channel></rss>";
  const fixedBytes = new TextEncoder().encode(prefix + suffix).byteLength;
  const available = targetBytes - fixedBytes;
  const doubleByteCharacters = Math.floor(available / 2);
  const remainder = available % 2;
  const filler = "é".repeat(doubleByteCharacters) + (remainder === 1 ? "a" : "");
  const xml = prefix + filler + suffix;
  assert.equal(new TextEncoder().encode(xml).byteLength, targetBytes);
  return xml;
}

test("extracts only discovery fields and excludes article and extension bodies", () => {
  const xml = feed(
    "<title>SYNTHETIC TEST ONLY: ignored channel title</title>" +
    item(
      "<title><![CDATA[SYNTHETIC TEST ONLY: a &lt;fixture&gt; title]]></title>" +
      "<link>https://untrusted.invalid/path?mode=synthetic&amp;next=raw</link>" +
      "<guid isPermaLink=\"false\">urn:synthetic:item:001</guid>" +
      "<pubDate>raw source date string; not event time</pubDate>" +
      "<description>SYNTHETIC TEST ONLY: excluded article body</description>" +
      "<content:encoded>SYNTHETIC TEST ONLY: excluded encoded body</content:encoded>" +
      "<ext:payload>SYNTHETIC TEST ONLY: excluded extension body</ext:payload>" +
      "<image><url>https://synthetic.invalid/image-only</url></image>" +
      "<enclosure url=\"https://synthetic.invalid/enclosure-only\" length=\"1\" type=\"image/png\"/>",
    ),
  );
  const result = parse(xml);
  assert.deepEqual(result, {
    kind: "feed",
    retrievedAt: RETRIEVED_AT,
    items: [{
      title: "SYNTHETIC TEST ONLY: a &lt;fixture&gt; title",
      link: "https://untrusted.invalid/path?mode=synthetic&next=raw",
      guid: "urn:synthetic:item:001",
      pubDate: "raw source date string; not event time",
    }],
  });
  assert.ok(!JSON.stringify(result).includes("excluded"));
  assert.ok(!JSON.stringify(result).includes("image-only"));
  assert.ok(!JSON.stringify(result).includes("enclosure-only"));
});

test("returns empty feeds and nulls for missing optional fields", () => {
  assert.deepEqual(parse(feed("")), { kind: "feed", retrievedAt: RETRIEVED_AT, items: [] });
  assert.deepEqual(parse(feed(item(""))), {
    kind: "feed",
    retrievedAt: RETRIEVED_AT,
    items: [{ title: null, link: null, guid: null, pubDate: null }],
  });
});

test("preserves multiple item order and CDATA values", () => {
  assert.deepEqual(parse(feed(
    item("<title><![CDATA[first synthetic title]]></title><link>opaque link one</link>") +
    item("<title>second synthetic title</title><guid><![CDATA[opaque-guid-2]]></guid>"),
  )), {
    kind: "feed",
    retrievedAt: RETRIEVED_AT,
    items: [
      { title: "first synthetic title", link: "opaque link one", guid: null, pubDate: null },
      { title: "second synthetic title", link: null, guid: "opaque-guid-2", pubDate: null },
    ],
  });
});

test("rejects malformed, wrong-root, unsupported-version, missing and duplicate channels", () => {
  assert.equal(errorCode(parse("<rss version=\"2.0\"><channel><item></channel></rss>")), "invalid_xml");
  assert.equal(errorCode(parse("<not-rss version=\"2.0\"><channel/></not-rss>")), "invalid_root");
  assert.equal(errorCode(parse("<rss version=\"1.0\"><channel/></rss>")), "unsupported_version");
  assert.equal(errorCode(parse("<rss version=\"2.0\"/>")), "invalid_structure");
  assert.equal(errorCode(parse("<rss xmlns=\"urn:synthetic:wrong\" version=\"2.0\"><channel/></rss>")), "invalid_root");
  assert.equal(errorCode(parse("<rss version=\"2.0\"><channel/><channel/></rss>")), "invalid_structure");
});

test("rejects duplicate extracted fields and nested scalar markup", () => {
  assert.equal(errorCode(parse(feed(item("<title>a</title><title>b</title>")))), "duplicate_field");
  assert.equal(errorCode(parse(feed(item("<guid>a</guid><guid>b</guid>")))), "duplicate_field");
  assert.equal(errorCode(parse(feed(item("<title>outer<ext:em>nested</ext:em></title>")))), "invalid_structure");
});

test("ignores unknown namespaces without returning extension text", () => {
  const result = parse(feed(item(
    '<ext:wrapper><ext:title>SYNTHETIC TEST ONLY: extension sentinel</ext:title></ext:wrapper><title>safe fixture</title>',
  )));
  assert.deepEqual(result, {
    kind: "feed",
    retrievedAt: RETRIEVED_AT,
    items: [{ title: "safe fixture", link: null, guid: null, pubDate: null }],
  });
  assert.ok(!JSON.stringify(result).includes("extension sentinel"));
});

test("rejects internal and external entity declarations through the DOCTYPE gate", () => {
  const internal = '<!DOCTYPE rss [<!ENTITY fixture "SYNTHETIC TEST ONLY expansion">]>';
  const external = '<!DOCTYPE rss [<!ENTITY fixture SYSTEM "urn:synthetic:entity">]>';
  for (const declaration of [internal, external]) {
    const xml = declaration + "<rss version=\"2.0\"><channel><item><title>&fixture;</title></item></channel></rss>";
    assert.equal(errorCode(parse(xml)), "doctype_forbidden");
  }
});

test("enforces UTF-8 byte input limit at and beyond the boundary", () => {
  assert.equal(parseRssDiscoveryXml(exactInputOfBytes(RSS_DISCOVERY_LIMITS.maxInputBytes), RETRIEVED_AT).kind, "feed");
  assert.equal(
    errorCode(parseRssDiscoveryXml(exactInputOfBytes(RSS_DISCOVERY_LIMITS.maxInputBytes + 1), RETRIEVED_AT)),
    "input_too_large",
  );
});

test("enforces element-count and nesting-depth limits", () => {
  const extensionElements = (count: number): string => "<ext:node/>".repeat(count);
  const exactElementCount = RSS_DISCOVERY_LIMITS.maxElements - 2;
  assert.equal(parse(feed(extensionElements(exactElementCount))).kind, "feed");
  assert.equal(errorCode(parse(feed(extensionElements(exactElementCount + 1)))), "element_limit_exceeded");

  const exactNestedCount = RSS_DISCOVERY_LIMITS.maxDepth - 2;
  const nested = "<ext:n>".repeat(exactNestedCount - 1) + "<ext:leaf/>" + "</ext:n>".repeat(exactNestedCount - 1);
  assert.equal(parse(feed(nested)).kind, "feed");
  const tooDeep = "<ext:n>".repeat(exactNestedCount) + "<ext:leaf/>" + "</ext:n>".repeat(exactNestedCount);
  assert.equal(errorCode(parse(feed(tooDeep))), "depth_limit_exceeded");
});

test("enforces aggregate text and item-count limits", () => {
  // The root version attribute is also charged to the global text budget.
  const exactTextCharacters = RSS_DISCOVERY_LIMITS.maxTextCharacters - 3;
  const exactText = "<rss version=\"2.0\"><channel><payload>" + "x".repeat(exactTextCharacters) + "</payload></channel></rss>";
  assert.equal(parse(exactText).kind, "feed");
  const overText = "<rss version=\"2.0\"><channel><payload>" + "x".repeat(exactTextCharacters + 1) + "</payload></channel></rss>";
  assert.equal(errorCode(parse(overText)), "text_limit_exceeded");

  const exactItems = item("").repeat(RSS_DISCOVERY_LIMITS.maxItems);
  assert.equal(parse(feed(exactItems)).kind, "feed");
  assert.equal(errorCode(parse(feed(exactItems + item("")))), "item_limit_exceeded");
});

test("enforces each extracted field limit and returns no partial output", () => {
  const fields = [
    ["title", RSS_DISCOVERY_LIMITS.maxTitleCharacters],
    ["link", RSS_DISCOVERY_LIMITS.maxLinkCharacters],
    ["guid", RSS_DISCOVERY_LIMITS.maxGuidCharacters],
    ["pubDate", RSS_DISCOVERY_LIMITS.maxPubDateCharacters],
  ] as const;
  for (const [name, maxCharacters] of fields) {
    const exactValue = "x".repeat(maxCharacters);
    const exact = parse(feed(item("<" + name + ">" + exactValue + "</" + name + ">")));
    assert.equal(exact.kind, "feed", name + " boundary");
    const overlong = "<" + name + ">" + "x".repeat(maxCharacters + 1) + "</" + name + ">";
    const result = parse(feed(item("<title>safe synthetic value</title>") + item(overlong)));
    assert.equal(errorCode(result), "field_limit_exceeded", name + " limit");
    assert.ok(!JSON.stringify(result).includes("safe synthetic value"));
  }
});

test("validates caller retrieval timestamp and its length bound", () => {
  assert.equal(parse(feed(""), "2000-02-29T14:00:00.123+07:00").kind, "feed");
  assert.equal(errorCode(parse(feed(""), "2001-02-29T14:00:00Z")), "invalid_retrieved_at");
  assert.equal(errorCode(parse(feed(""), "2001-02-03T25:00:00Z")), "invalid_retrieved_at");
  const maximumLength = "2001-02-03T14:00:00." + "1".repeat(43) + "Z";
  assert.equal(maximumLength.length, RSS_DISCOVERY_LIMITS.maxRetrievedAtCharacters);
  assert.equal(parse(feed(""), maximumLength).kind, "feed");
  const tooLong = "2001-02-03T14:00:00." + "1".repeat(44) + "Z";
  assert.equal(tooLong.length, RSS_DISCOVERY_LIMITS.maxRetrievedAtCharacters + 1);
  assert.equal(errorCode(parse(feed(""), tooLong)), "invalid_retrieved_at");
});

test("returns closed error codes and discards previously parsed items on failure", () => {
  const result = parse(feed(item("<title>SYNTHETIC TEST ONLY: discarded</title>") + item("<link>x</link><link>y</link>")));
  assert.equal(errorCode(result), "duplicate_field");
  assert.ok(!JSON.stringify(result).includes("discarded"));
});
