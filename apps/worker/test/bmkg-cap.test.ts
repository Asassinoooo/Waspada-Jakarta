import assert from "node:assert/strict";
import test from "node:test";
import {
  BMKG_CAP_LIMITS,
  parseCap12Xml,
  type CapParseResult,
} from "../src/layers/l1-data-knowledge/bmkg-cap.js";

// Authored synthetic XML only. These strings do not describe a real warning,
// issuer, affected area, BMKG mapping, or source rights.
const CAP_NS = "urn:oasis:names:tc:emergency:cap:1.2";
const RETRIEVED_AT = "2001-02-03T14:00:00Z";
const SENT = "2001-02-03T10:00:00+07:00";
const EFFECTIVE = "2001-02-03T11:00:00+07:00";
const ONSET = "2001-02-03T12:00:00+07:00";
const EXPIRES = "2001-02-03T13:00:00+07:00";
const FIXTURE_LABEL = "SYNTHETIC TEST ONLY — not a live alert";

type NamespaceStyle = "default" | "prefixed";

function openAlert(style: NamespaceStyle = "default"): string {
  return style === "default"
    ? `<alert xmlns="${CAP_NS}" xmlns:cap="${CAP_NS}" xmlns:ext="urn:synthetic:extension">`
    : `<cap:alert xmlns:cap="${CAP_NS}" xmlns:ext="urn:synthetic:extension">`;
}

function closeAlert(style: NamespaceStyle = "default"): string {
  return style === "default" ? "</alert>" : "</cap:alert>";
}

function element(style: NamespaceStyle, name: string, content: string): string {
  const qualified = style === "default" ? name : `cap:${name}`;
  return `<${qualified}>${content}</${qualified}>`;
}

function alertFields(
  style: NamespaceStyle = "default",
  options: { readonly identifier?: string; readonly sender?: string; readonly sent?: string;
    readonly status?: string; readonly msgType?: string; readonly scope?: string;
    readonly references?: string | null; readonly incidents?: string | null } = {},
): string {
  const fields = [
    element(style, "identifier", options.identifier ?? "synthetic-cap-001"),
    element(style, "sender", options.sender ?? "fixture.invalid"),
    element(style, "sent", options.sent ?? SENT),
    element(style, "status", options.status ?? "Actual"),
    element(style, "msgType", options.msgType ?? "Alert"),
    element(style, "scope", options.scope ?? "Public"),
  ];
  if (options.references !== undefined && options.references !== null) {
    fields.push(element(style, "references", options.references));
  }
  if (options.incidents !== undefined && options.incidents !== null) {
    fields.push(element(style, "incidents", options.incidents));
  }
  return fields.join("");
}

function syntheticInfo(options: {
  readonly style?: NamespaceStyle;
  readonly language?: string | null;
  readonly event?: string;
  readonly categories?: readonly string[];
  readonly description?: string;
  readonly effective?: string | null;
  readonly onset?: string | null;
  readonly expires?: string | null;
  readonly extra?: string;
  readonly areas?: readonly string[];
} = {}): string {
  const style = options.style ?? "default";
  const tag = style === "default" ? "info" : "cap:info";
  const language = options.language === undefined || options.language === null
    ? ""
    : ` xml:lang="${options.language}"`;
  const fields = [
    ...(options.categories ?? ["Met"]).map((category) => element(style, "category", category)),
    element(style, "event", options.event ?? `${FIXTURE_LABEL}: parser-only event text.`),
    element(style, "urgency", "Unknown"),
    element(style, "severity", "Unknown"),
    element(style, "certainty", "Unknown"),
  ];
  if (options.effective !== undefined && options.effective !== null) fields.push(element(style, "effective", options.effective));
  if (options.onset !== undefined && options.onset !== null) fields.push(element(style, "onset", options.onset));
  if (options.expires !== undefined && options.expires !== null) fields.push(element(style, "expires", options.expires));
  fields.push(element(style, "headline", `${FIXTURE_LABEL}: headline.`));
  fields.push(element(style, "description", options.description ?? `${FIXTURE_LABEL}: description &amp; detail.`));
  fields.push(element(style, "instruction", `${FIXTURE_LABEL}: no operational instruction.`));
  fields.push(element(style, "web", "https://synthetic.invalid/fixture"));
  fields.push(...(options.areas ?? []));
  if (options.extra !== undefined) fields.push(options.extra);
  return `<${tag}${language}>${fields.join("")}</${tag}>`;
}

function syntheticArea(style: NamespaceStyle = "default"): string {
  return [
    "<area>",
    element(style, "areaDesc", `${FIXTURE_LABEL}: imaginary test area.`),
    `<geocode>${element(style, "valueName", "SYNTHETIC-CODE")}${element(style, "value", "fiction-001")}</geocode>`,
    element(style, "circle", "1,2 0.5"),
    element(style, "polygon", "1,2 1,3 2,3 1,2"),
    "</area>",
  ].join("");
}

function syntheticXml(
  body = syntheticInfo(),
  options: { readonly style?: NamespaceStyle; readonly fields?: string; readonly rootNamespace?: string } = {},
): string {
  const style = options.style ?? "default";
  const root = openAlert(style).replace(CAP_NS, options.rootNamespace ?? CAP_NS);
  return `<?xml version="1.0" encoding="UTF-8"?>${root}${options.fields ?? alertFields(style)}${body}${closeAlert(style)}`;
}

function errorOf(result: CapParseResult): Extract<CapParseResult, { readonly kind: "error" }> {
  assert.equal(result.kind, "error");
  if (result.kind !== "error") throw new Error("expected a bounded parser error");
  assert.equal("message" in result, false);
  return result;
}

function parse(xml: string, retrievedAt = RETRIEVED_AT): CapParseResult {
  return parseCap12Xml(xml, retrievedAt);
}

test("default and prefixed CAP namespaces parse the same source fields", () => {
  for (const style of ["default", "prefixed"] as const) {
    const messageResult = parse(syntheticXml(syntheticInfo({ style, language: "id-ID" }), { style }));
    assert.equal(messageResult.kind, "message");
    if (messageResult.kind !== "message") continue;
    assert.equal(messageResult.message.identifier, "synthetic-cap-001");
    assert.equal(messageResult.message.sender, "fixture.invalid");
    assert.equal(messageResult.message.sent, SENT);
    assert.equal(messageResult.message.status, "Actual");
    assert.equal(messageResult.message.messageType, "Alert");
    assert.equal(messageResult.message.scope, "Public");
    assert.equal(messageResult.message.retrievedAt, RETRIEVED_AT);
    assert.equal(messageResult.message.infos[0]?.language, "id-ID");
    assert.equal(messageResult.message.infos[0]?.description, `${FIXTURE_LABEL}: description & detail.`);
    assert.equal(messageResult.message.infos[0]?.headline, `${FIXTURE_LABEL}: headline.`);
    assert.equal(messageResult.message.infos[0]?.instruction, `${FIXTURE_LABEL}: no operational instruction.`);
    assert.equal(messageResult.message.infos[0]?.web, "https://synthetic.invalid/fixture");
  }
});

test("multiple language-specific info blocks preserve source categories, text, and areas", () => {
  const result = parse(syntheticXml([
    syntheticInfo({ language: "id-ID", categories: ["Met", "Transport"], areas: [syntheticArea()] }),
    syntheticInfo({ style: "prefixed", language: "en-GB", categories: ["Other"], areas: [syntheticArea("prefixed")] }),
  ].join("")));

  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;
  assert.equal(result.message.infos.length, 2);
  assert.deepEqual(result.message.infos.map(({ language, categories }) => ({ language, categories })), [
    { language: "id-ID", categories: ["Met", "Transport"] },
    { language: "en-GB", categories: ["Other"] },
  ]);
  assert.equal(result.message.infos[0]?.areas[0]?.description, `${FIXTURE_LABEL}: imaginary test area.`);
  assert.deepEqual(result.message.infos[0]?.areas[0]?.geocodes, [
    { valueName: "SYNTHETIC-CODE", value: "fiction-001" },
  ]);
  assert.deepEqual(result.message.infos[0]?.areas[0]?.circles, ["1,2 0.5"]);
  assert.equal(result.message.infos[0]?.areas[0]?.polygons[0]?.sourceText, "1,2 1,3 2,3 1,2");
  assert.equal("geometry" in (result.message.infos[0]?.areas[0] ?? {}), false);
});

test("CAP categories, event fields, message status, message type, and scope remain distinct", () => {
  const result = parse(syntheticXml(syntheticInfo({ categories: ["CBRNE", "Infra"] }), {
    fields: alertFields("default", { status: "Test", msgType: "Ack", scope: "Restricted" }),
  }));
  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;
  assert.equal(result.message.status, "Test");
  assert.equal(result.message.messageType, "Ack");
  assert.equal(result.message.scope, "Restricted");
  assert.deepEqual(result.message.infos[0]?.categories, ["CBRNE", "Infra"]);
  assert.equal(result.message.infos[0]?.urgency, "Unknown");
  assert.equal(result.message.infos[0]?.severity, "Unknown");
  assert.equal(result.message.infos[0]?.certainty, "Unknown");
});

test("Alert, Update, and Cancel keep their source linkage without applying it", () => {
  const reference = "fixture.invalid,synthetic-cap-001,2001-02-03T10:00:00+07:00";
  const alert = parse(syntheticXml("", { fields: alertFields("default", { msgType: "Alert" }) }));
  const update = parse(syntheticXml("", { fields: alertFields("default", { identifier: "synthetic-cap-002", msgType: "Update", references: reference }) }));
  const cancel = parse(syntheticXml("", { fields: alertFields("default", {
    identifier: "synthetic-cap-003", msgType: "Cancel", references: reference, incidents: '"synthetic incident 001"',
  }) }));
  for (const result of [alert, update, cancel]) assert.equal(result.kind, "message");
  if (alert.kind !== "message" || update.kind !== "message" || cancel.kind !== "message") return;
  assert.equal(alert.message.messageType, "Alert");
  assert.equal(update.message.messageType, "Update");
  assert.equal(update.message.references, reference);
  assert.equal(cancel.message.messageType, "Cancel");
  assert.equal(cancel.message.references, reference);
  assert.equal(cancel.message.incidents, '"synthetic incident 001"');
  assert.equal(alert.message.identifier, "synthetic-cap-001");
});

test("CAP identifiers preserve permitted greater-than characters after XML decoding", () => {
  const references = "fixture&gt;.invalid,synthetic&gt;cap-001,2001-02-03T10:00:00+07:00";
  const result = parse(syntheticXml("", {
    fields: alertFields("default", {
      identifier: "synthetic&gt;cap-001",
      sender: "fixture&gt;.invalid",
      references,
    }),
  }));
  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;
  assert.equal(result.message.identifier, "synthetic>cap-001");
  assert.equal(result.message.sender, "fixture>.invalid");
  assert.equal(result.message.references, "fixture>.invalid,synthetic>cap-001,2001-02-03T10:00:00+07:00");
});

test("sent, effective, onset, expires, and caller retrieval time stay separate", () => {
  const result = parse(syntheticXml(syntheticInfo({ effective: EFFECTIVE, onset: ONSET, expires: EXPIRES })));
  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;
  const info = result.message.infos[0];
  assert.equal(result.message.sent, SENT);
  assert.equal(info?.effective, EFFECTIVE);
  assert.equal(info?.onset, ONSET);
  assert.equal(info?.expires, EXPIRES);
  assert.equal(result.message.retrievedAt, RETRIEVED_AT);

  const omittedEffective = parse(syntheticXml(syntheticInfo()));
  assert.equal(omittedEffective.kind, "message");
  if (omittedEffective.kind === "message") assert.equal(omittedEffective.message.infos[0]?.effective, null);
});

test("CAP timestamps require valid calendar dates and explicit numeric offsets", () => {
  for (const invalid of [
    "2001-02-29T10:00:00+07:00",
    "2001-02-03T10:00:00Z",
    "2001-02-03T10:00:00.5+07:00",
    "2001-02-03T24:00:00+07:00",
    "2001-02-03T10:00:00+14:01",
  ]) {
    const result = errorOf(parse(syntheticXml("", {
      fields: alertFields("default", { sent: invalid }),
    })));
    assert.equal(result.error.code, "invalid_datetime");
  }
  for (const field of ["effective", "onset", "expires"] as const) {
    const invalid = syntheticInfo({ [field]: "2001-02-30T10:00:00+07:00" });
    assert.equal(errorOf(parse(syntheticXml(invalid))).error.code, "invalid_datetime");
  }
  assert.equal(errorOf(parse(syntheticXml(), "2001-02-30T14:00:00Z")).error.code, "invalid_retrieved_at");
  const oversizedFraction = `2001-02-03T14:00:00.${"1".repeat(44)}Z`;
  assert.equal(oversizedFraction.length, BMKG_CAP_LIMITS.maxRetrievedAtCharacters + 1);
  assert.equal(errorOf(parse(syntheticXml(), oversizedFraction)).error.code, "invalid_retrieved_at");
  assert.equal(parse(syntheticXml(), "2001-02-03T14:00:00+07:00").kind, "message");
});

test("only source polygons become CRS84 positions, with closure and WGS 84 bounds checked", () => {
  const result = parse(syntheticXml(syntheticInfo({ areas: [syntheticArea()] })));
  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;
  assert.deepEqual(result.message.infos[0]?.areas[0]?.polygons[0]?.coordinates, [
    [2, 1], [3, 1], [3, 2], [2, 1],
  ]);

  for (const polygon of [
    "1,2 1,3 2,3 2,2", // not closed
    "1,2 1,3 1,2", // fewer than four positions
    "91,2 91,3 92,3 91,2", // latitude out of bounds
    "1,181 1,3 2,3 1,181", // longitude out of bounds
    "1,2 1,3 NaN,3 1,2", // non-decimal coordinate
  ]) {
    const invalidArea = `<area>${element("default", "areaDesc", `${FIXTURE_LABEL}: invalid polygon.`)}${element("default", "polygon", polygon)}</area>`;
    const invalid = errorOf(parse(syntheticXml(syntheticInfo({ areas: [invalidArea] }))));
    assert.equal(invalid.error.code, "invalid_polygon");
  }
});

test("empty-info System messages are preserved as messages with no info records", () => {
  const result = parse(syntheticXml("", {
    fields: alertFields("default", {
      status: "System",
      msgType: "Error",
      references: "fixture.invalid,synthetic-reference,2001-02-03T10:00:00+07:00",
    }),
  }));
  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;
  assert.equal(result.message.status, "System");
  assert.equal(result.message.messageType, "Error");
  assert.deepEqual(result.message.infos, []);
});

test("extension namespaces are ignored and same-named extension fields cannot satisfy CAP fields", () => {
  const style: NamespaceStyle = "default";
  const extension = `<ext:identifier>synthetic-spoofed-identifier</ext:identifier><ext:info><cap:identifier>nested ignored</cap:identifier></ext:info>`;
  const xml = syntheticXml(syntheticInfo({ extra: extension }), {
    fields: `${element(style, "identifier", "synthetic-real-identifier")}${element(style, "sender", "fixture.invalid")}${element(style, "sent", SENT)}${element(style, "status", "Actual")}${element(style, "msgType", "Alert")}${element(style, "scope", "Public")}<ext:sender>synthetic-spoofed-sender</ext:sender>`,
  });
  const result = parse(xml);
  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;
  assert.equal(result.message.identifier, "synthetic-real-identifier");
  assert.equal(result.message.sender, "fixture.invalid");

  const missingCapField = syntheticXml("", {
    fields: `${element(style, "identifier", "synthetic-real-identifier")}${element(style, "sender", "fixture.invalid")}${element(style, "sent", SENT)}${element(style, "status", "Actual")}${element(style, "msgType", "Alert")}<ext:scope>Public</ext:scope>`,
  });
  assert.equal(errorOf(parse(missingCapField)).error.code, "missing_required_field");
});

test("wrong CAP namespaces, duplicate required fields, and malformed XML fail without partial output", () => {
  const wrongNamespace = syntheticXml(syntheticInfo(), { rootNamespace: "urn:synthetic:not-cap" });
  assert.equal(errorOf(parse(wrongNamespace)).error.code, "wrong_namespace");

  const duplicateFields = `${alertFields()}${element("default", "identifier", "synthetic-duplicate")}`;
  assert.equal(errorOf(parse(syntheticXml("", { fields: duplicateFields }))).error.code, "duplicate_field");

  const malformed = `${openAlert()}${alertFields("default", { identifier: "SYNTHETIC_SECRET_MARKER" })}<info>`;
  const result = errorOf(parse(malformed));
  assert.equal(result.error.code, "invalid_xml");
  assert.equal(JSON.stringify(result).includes("SYNTHETIC SECRET MARKER"), false);
});

test("DOCTYPE, external entities, and internal entity expansion are rejected without resolution", () => {
  const payloads = [
    `<!DOCTYPE alert [<!ENTITY ext SYSTEM "https://synthetic.invalid/no-fetch">]><alert xmlns="${CAP_NS}">${alertFields()}</alert>`,
    `<!DOCTYPE alert [<!ENTITY first "synthetic-secret"><!ENTITY expanded "&first;&first;&first;">]><alert xmlns="${CAP_NS}">${alertFields()}<info>&expanded;</info></alert>`,
  ];
  for (const payload of payloads) {
    const result = errorOf(parse(payload));
    assert.equal(result.error.code, "doctype_forbidden");
    assert.equal(JSON.stringify(result).includes(payload), false);
    assert.equal("message" in result, false);
  }
});

test("predefined XML entities are decoded while no source content appears in parser errors", () => {
  const result = parse(syntheticXml(syntheticInfo()));
  assert.equal(result.kind, "message");
  if (result.kind === "message") assert.equal(result.message.infos[0]?.description, `${FIXTURE_LABEL}: description & detail.`);
});

test("all configured input, XML, field, info, area, and geometry limits are enforced", () => {
  assert.equal(errorOf(parse("x".repeat(BMKG_CAP_LIMITS.maxInputBytes + 1))).error.code, "input_too_large");

  const elementFlood = `${Array.from({ length: BMKG_CAP_LIMITS.maxElements }, () => "<ext:e/>").join("")}`;
  assert.equal(errorOf(parse(syntheticXml(elementFlood))).error.code, "element_limit_exceeded");

  const deepOpen = "<ext:n>".repeat(BMKG_CAP_LIMITS.maxDepth);
  const deepClose = "</ext:n>".repeat(BMKG_CAP_LIMITS.maxDepth);
  assert.equal(errorOf(parse(syntheticXml(`${deepOpen}${deepClose}`))).error.code, "depth_limit_exceeded");

  const tooMuchText = `<ext:opaque>${"x".repeat(BMKG_CAP_LIMITS.maxTextCharacters + 1)}</ext:opaque>`;
  assert.equal(errorOf(parse(syntheticXml(tooMuchText))).error.code, "text_limit_exceeded");

  const longDescription = `${FIXTURE_LABEL}${"x".repeat(BMKG_CAP_LIMITS.maxFieldCharacters)}`;
  assert.equal(errorOf(parse(syntheticXml(syntheticInfo({ description: longDescription })))).error.code, "field_limit_exceeded");

  const longPolygon = "0,0 ".repeat(Math.floor(BMKG_CAP_LIMITS.maxPolygonCharacters / 4) + 1);
  const polygonLongArea = `<area>${element("default", "areaDesc", `${FIXTURE_LABEL}: bound test.`)}${element("default", "polygon", longPolygon)}</area>`;
  assert.equal(errorOf(parse(syntheticXml(syntheticInfo({ areas: [polygonLongArea] })))).error.code, "field_limit_exceeded");

  const overInfo = Array.from({ length: BMKG_CAP_LIMITS.maxInfoBlocks + 1 }, () => syntheticInfo()).join("");
  assert.equal(errorOf(parse(syntheticXml(overInfo))).error.code, "info_limit_exceeded");

  const overCategories = syntheticInfo({ categories: Array.from({ length: BMKG_CAP_LIMITS.maxCategoriesPerInfo + 1 }, () => "Met") });
  assert.equal(errorOf(parse(syntheticXml(overCategories))).error.code, "field_limit_exceeded");

  const area = `<area>${element("default", "areaDesc", `${FIXTURE_LABEL}: area bound.`)}</area>`;
  const tooManyPerInfo = syntheticInfo({ areas: Array.from({ length: BMKG_CAP_LIMITS.maxAreasPerInfo + 1 }, () => area) });
  assert.equal(errorOf(parse(syntheticXml(tooManyPerInfo))).error.code, "area_limit_exceeded");

  const totalAreasBody = Array.from({ length: 5 }, (_, index) => syntheticInfo({
    language: `x-${index}`,
    areas: Array.from({ length: index === 4 ? 25 : 26 }, () => area),
  })).join("");
  assert.equal(errorOf(parse(syntheticXml(totalAreasBody))).error.code, "area_limit_exceeded");

  const polygon = element("default", "polygon", "1,2 1,3 2,3 1,2");
  const polygonBoundArea = `<area>${element("default", "areaDesc", `${FIXTURE_LABEL}: polygon count.`)}${polygon.repeat(BMKG_CAP_LIMITS.maxPolygonsPerArea + 1)}</area>`;
  assert.equal(errorOf(parse(syntheticXml(syntheticInfo({ areas: [polygonBoundArea] })))).error.code, "polygon_limit_exceeded");

  const circle = element("default", "circle", "1,2 0.5");
  const circleBoundArea = `<area>${element("default", "areaDesc", `${FIXTURE_LABEL}: circle count.`)}${circle.repeat(BMKG_CAP_LIMITS.maxCirclesPerArea + 1)}</area>`;
  assert.equal(errorOf(parse(syntheticXml(syntheticInfo({ areas: [circleBoundArea] })))).error.code, "circle_limit_exceeded");

  const geocode = `<geocode>${element("default", "valueName", "SYNTHETIC-CODE")}${element("default", "value", "fiction")}</geocode>`;
  const geocodeBoundArea = `<area>${element("default", "areaDesc", `${FIXTURE_LABEL}: geocode count.`)}${geocode.repeat(BMKG_CAP_LIMITS.maxGeocodesPerArea + 1)}</area>`;
  assert.equal(errorOf(parse(syntheticXml(syntheticInfo({ areas: [geocodeBoundArea] })))).error.code, "geocode_limit_exceeded");

  const tooManyCoordinates = "0,0 ".repeat(BMKG_CAP_LIMITS.maxCoordinatePairs + 1);
  const coordinateArea = `<area>${element("default", "areaDesc", `${FIXTURE_LABEL}: coordinate count.`)}${element("default", "polygon", tooManyCoordinates)}</area>`;
  assert.equal(errorOf(parse(syntheticXml(syntheticInfo({ areas: [coordinateArea] })))).error.code, "coordinate_limit_exceeded");
});

test("required CAP values and caller retrieval time are validated as bounded data", () => {
  const invalidEnum = alertFields("default", { status: "synthetic-unknown-status" });
  assert.equal(errorOf(parse(syntheticXml("", { fields: invalidEnum }))).error.code, "invalid_field_value");

  const longIdentifier = "x".repeat(BMKG_CAP_LIMITS.maxIdentifierCharacters + 1);
  assert.equal(errorOf(parse(syntheticXml("", { fields: alertFields("default", { identifier: longIdentifier }) }))).error.code, "invalid_field_value");

  const longLanguage = "x".repeat(BMKG_CAP_LIMITS.maxFieldCharacters + 1);
  assert.equal(errorOf(parse(syntheticXml(syntheticInfo({ language: longLanguage })))).error.code, "field_limit_exceeded");

  const missingEvent = syntheticInfo().replace(element("default", "event", `${FIXTURE_LABEL}: parser-only event text.`), "");
  assert.equal(errorOf(parse(syntheticXml(missingEvent))).error.code, "missing_required_field");

  const malformedReference = alertFields("default", {
    msgType: "Update",
    references: "fixture.invalid,missing-sent-time",
  });
  assert.equal(errorOf(parse(syntheticXml("", { fields: malformedReference }))).error.code, "invalid_field_value");

  const malformedIncident = alertFields("default", {
    msgType: "Cancel",
    incidents: '"synthetic incident 001"unseparated',
  });
  assert.equal(errorOf(parse(syntheticXml("", { fields: malformedIncident }))).error.code, "invalid_field_value");
});
