import { SaxesParser } from "saxes";
import type { SaxesTagNS } from "saxes";

/**
 * Pure CAP 1.2 extraction from caller-buffered XML. The module does not fetch,
 * persist, classify, authenticate, verify signatures, or publish messages.
 * Synthetic contract tests do not establish BMKG field mappings, source
 * identity, source rights, truth, Jakarta relevance, warning freshness, or
 * current danger. Successful parsing establishes syntax and field extraction
 * only. Keep the BMKG connector disabled until source registry and rights gates
 * are satisfied. Absent CAP times and xml:lang remain null in this extraction
 * result; timestamps and language are never inferred from unrelated fields.
 */

export const BMKG_CAP_LIMITS = {
  maxInputBytes: 1_048_576,
  maxElements: 10_000,
  maxDepth: 32,
  maxTextCharacters: 524_288,
  maxFieldCharacters: 8_192,
  maxPolygonCharacters: 400_000,
  maxIdentifierCharacters: 256,
  /** Maximum length for the caller-supplied retrieval timestamp, including any fraction. */
  maxRetrievedAtCharacters: 64,
  maxInfoBlocks: 16,
  maxCategoriesPerInfo: 12,
  maxAreasPerInfo: 32,
  maxTotalAreas: 128,
  maxPolygonsPerArea: 16,
  maxCirclesPerArea: 16,
  maxGeocodesPerArea: 32,
  maxCoordinatePairs: 20_000,
} as const;

const CAP_NAMESPACE = "urn:oasis:names:tc:emergency:cap:1.2";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

export type CapStatus = "Actual" | "Exercise" | "System" | "Test" | "Draft";
export type CapMessageType = "Alert" | "Update" | "Cancel" | "Ack" | "Error";
export type CapScope = "Public" | "Restricted" | "Private";
export type CapCategory =
  | "Geo"
  | "Met"
  | "Safety"
  | "Security"
  | "Rescue"
  | "Fire"
  | "Health"
  | "Env"
  | "Transport"
  | "Infra"
  | "CBRNE"
  | "Other";
export type CapUrgency = "Immediate" | "Expected" | "Future" | "Past" | "Unknown";
export type CapSeverity = "Extreme" | "Severe" | "Moderate" | "Minor" | "Unknown";
export type CapCertainty = "Observed" | "Likely" | "Possible" | "Unlikely" | "Unknown" | "Very Likely";

export type CapCrs84Position = readonly [longitude: number, latitude: number];

export interface CapPolygon {
  /** Exact decoded polygon field value, retained as source text. */
  readonly sourceText: string;
  /** CAP [latitude, longitude] pairs reordered as CRS84 [longitude, latitude]. */
  readonly coordinates: readonly CapCrs84Position[];
}

export interface CapGeocode {
  readonly valueName: string;
  readonly value: string;
}

export interface CapArea {
  readonly description: string;
  readonly geocodes: readonly CapGeocode[];
  /** Source circle values stay strings; this parser creates no point or buffer. */
  readonly circles: readonly string[];
  readonly polygons: readonly CapPolygon[];
}

export interface CapInfo {
  /** Explicit xml:lang value, or null when the attribute was absent. */
  readonly language: string | null;
  readonly categories: readonly CapCategory[];
  readonly event: string;
  readonly urgency: CapUrgency;
  readonly severity: CapSeverity;
  readonly certainty: CapCertainty;
  readonly effective: string | null;
  readonly onset: string | null;
  readonly expires: string | null;
  readonly headline: string | null;
  readonly description: string | null;
  readonly instruction: string | null;
  readonly web: string | null;
  readonly areas: readonly CapArea[];
}

export interface Cap12Message {
  readonly identifier: string;
  readonly sender: string;
  /** CAP message origination time, kept in its original offset-qualified form. */
  readonly sent: string;
  /** CAP protocol status only; it does not establish source approval or event lifecycle. */
  readonly status: CapStatus;
  readonly messageType: CapMessageType;
  /** Source-declared distribution scope only; it is not an authorization decision. */
  readonly scope: CapScope;
  /** CAP message references are preserved verbatim after XML entity decoding. */
  readonly references: string | null;
  readonly incidents: string | null;
  /** Caller-supplied retrieval time. It is never substituted for CAP times. */
  readonly retrievedAt: string;
  readonly infos: readonly CapInfo[];
}

export type CapParseErrorCode =
  | "invalid_retrieved_at"
  | "input_too_large"
  | "element_limit_exceeded"
  | "depth_limit_exceeded"
  | "text_limit_exceeded"
  | "field_limit_exceeded"
  | "info_limit_exceeded"
  | "area_limit_exceeded"
  | "polygon_limit_exceeded"
  | "circle_limit_exceeded"
  | "geocode_limit_exceeded"
  | "coordinate_limit_exceeded"
  | "doctype_forbidden"
  | "invalid_xml"
  | "wrong_namespace"
  | "invalid_root"
  | "invalid_structure"
  | "duplicate_field"
  | "missing_required_field"
  | "invalid_field_value"
  | "invalid_datetime"
  | "invalid_polygon";

export interface CapParseError {
  readonly kind: "malformed" | "unsupported";
  readonly code: CapParseErrorCode;
}

export type CapParseResult =
  | { readonly kind: "message"; readonly message: Cap12Message }
  | { readonly kind: "error"; readonly error: CapParseError };

type ErrorKind = CapParseError["kind"];

class CapParseFailure extends Error {
  constructor(readonly kind: ErrorKind, readonly code: CapParseErrorCode) {
    super(code);
  }
}

interface AlertBuilder {
  readonly scalarFields: Map<AlertScalarField, string>;
  readonly infos: CapInfo[];
}

interface InfoBuilder {
  readonly language: string | null;
  readonly scalarFields: Map<InfoScalarField, string>;
  readonly categories: CapCategory[];
  readonly areas: CapArea[];
}

interface AreaBuilder {
  readonly scalarFields: Map<AreaScalarField, string>;
  readonly geocodes: CapGeocode[];
  readonly circles: string[];
  readonly polygons: CapPolygon[];
  geocodeCount: number;
}

interface GeocodeBuilder {
  readonly scalarFields: Map<GeocodeScalarField, string>;
}

type AlertScalarField =
  | "identifier"
  | "sender"
  | "sent"
  | "status"
  | "msgType"
  | "scope"
  | "references"
  | "incidents";
type InfoScalarField =
  | "category"
  | "event"
  | "urgency"
  | "severity"
  | "certainty"
  | "effective"
  | "onset"
  | "expires"
  | "headline"
  | "description"
  | "instruction"
  | "web";
type AreaScalarField = "areaDesc" | "polygon" | "circle";
type GeocodeScalarField = "valueName" | "value";
type ScalarOwner = AlertBuilder | InfoBuilder | AreaBuilder | GeocodeBuilder;
type ScalarField = AlertScalarField | InfoScalarField | AreaScalarField | GeocodeScalarField;

type Frame =
  | { readonly role: "root"; readonly alert: AlertBuilder }
  | { readonly role: "info"; readonly info: InfoBuilder }
  | { readonly role: "area"; readonly area: AreaBuilder; readonly info: InfoBuilder }
  | { readonly role: "geocode"; readonly geocode: GeocodeBuilder; readonly area: AreaBuilder }
  | {
      readonly role: "scalar";
      readonly owner: ScalarOwner;
      readonly field: ScalarField;
      readonly parts: string[];
      textLength: number;
      hasChild: boolean;
    }
  | { readonly role: "ignored" };

interface ParseBudget {
  elements: number;
  textCharacters: number;
  totalAreas: number;
  coordinatePairs: number;
}

/** Parse an already-buffered CAP 1.2 XML message using synthetic-safe limits. */
export function parseCap12Xml(xmlText: string, retrievedAt: string): CapParseResult {
  if (typeof retrievedAt !== "string" || !isValidRetrievedAt(retrievedAt)) {
    return failure("malformed", "invalid_retrieved_at");
  }
  if (typeof xmlText !== "string") return failure("malformed", "invalid_xml");
  // Bound TextEncoder allocation before checking actual UTF-8 bytes.
  if (xmlText.length > BMKG_CAP_LIMITS.maxInputBytes) return failure("unsupported", "input_too_large");
  if (new TextEncoder().encode(xmlText).byteLength > BMKG_CAP_LIMITS.maxInputBytes) {
    return failure("unsupported", "input_too_large");
  }

  try {
    return parseXml(xmlText, retrievedAt);
  } catch (error) {
    if (error instanceof CapParseFailure) {
      return { kind: "error", error: { kind: error.kind, code: error.code } };
    }
    // Saxes errors can contain source excerpts and positions. Never expose them.
    return failure("malformed", "invalid_xml");
  }
}

function parseXml(xmlText: string, retrievedAt: string): CapParseResult {
  const parser = new SaxesParser({ xmlns: true, position: false });
  const stack: Frame[] = [];
  const budget: ParseBudget = { elements: 0, textCharacters: 0, totalAreas: 0, coordinatePairs: 0 };
  let alertBuilder: AlertBuilder | null = null;
  let rootClosed = false;
  let resultMessage: Cap12Message | null = null;

  parser.on("error", () => reject("malformed", "invalid_xml"));
  parser.on("doctype", () => reject("unsupported", "doctype_forbidden"));
  parser.on("comment", (comment) => addTextBudget(budget, comment.length));
  parser.on("processinginstruction", (instruction) => addTextBudget(budget, instruction.body.length));
  parser.on("text", (text) => acceptCharacterData(text, stack, budget));
  parser.on("cdata", (text) => acceptCharacterData(text, stack, budget));
  parser.on("xmldecl", (declaration) => {
    if (declaration.encoding !== undefined && declaration.encoding.toLowerCase() !== "utf-8") {
      reject("unsupported", "invalid_xml");
    }
  });

  parser.on("opentag", (tag: SaxesTagNS) => {
    budget.elements += 1;
    if (budget.elements > BMKG_CAP_LIMITS.maxElements) reject("unsupported", "element_limit_exceeded");
    if (stack.length + 1 > BMKG_CAP_LIMITS.maxDepth) reject("unsupported", "depth_limit_exceeded");
    for (const attribute of Object.values(tag.attributes)) addTextBudget(budget, attribute.value.length);

    const parent = stack.at(-1);
    if (parent === undefined) {
      if (tag.local !== "alert") reject("unsupported", "invalid_root");
      if (tag.uri !== CAP_NAMESPACE) reject("unsupported", "wrong_namespace");
      alertBuilder = { scalarFields: new Map(), infos: [] };
      stack.push({ role: "root", alert: alertBuilder });
      return;
    }
    if (parent.role === "ignored") {
      stack.push({ role: "ignored" });
      return;
    }
    if (parent.role === "scalar") {
      parent.hasChild = true;
      if (tag.uri === CAP_NAMESPACE) reject("malformed", "invalid_structure");
      stack.push({ role: "ignored" });
      return;
    }
    if (tag.uri !== CAP_NAMESPACE) {
      stack.push({ role: "ignored" });
      return;
    }

    if (parent.role === "root" && tag.local === "info") {
      if (parent.alert.infos.length >= BMKG_CAP_LIMITS.maxInfoBlocks) {
        reject("unsupported", "info_limit_exceeded");
      }
      const language = readXmlLanguage(tag);
      stack.push({
        role: "info",
        info: { language, scalarFields: new Map(), categories: [], areas: [] },
      });
      return;
    }
    if (parent.role === "info" && tag.local === "area") {
      if (parent.info.areas.length >= BMKG_CAP_LIMITS.maxAreasPerInfo
        || budget.totalAreas >= BMKG_CAP_LIMITS.maxTotalAreas) {
        reject("unsupported", "area_limit_exceeded");
      }
      budget.totalAreas += 1;
      stack.push({
        role: "area",
        info: parent.info,
        area: { scalarFields: new Map(), geocodes: [], circles: [], polygons: [], geocodeCount: 0 },
      });
      return;
    }
    if (parent.role === "area" && tag.local === "geocode") {
      if (parent.area.geocodeCount >= BMKG_CAP_LIMITS.maxGeocodesPerArea) {
        reject("unsupported", "geocode_limit_exceeded");
      }
      parent.area.geocodeCount += 1;
      stack.push({ role: "geocode", area: parent.area, geocode: { scalarFields: new Map() } });
      return;
    }

    const field = scalarFieldFor(parent.role, tag.local);
    if (field === null) {
      stack.push({ role: "ignored" });
      return;
    }
    const owner = scalarOwner(parent);
    if (isRepeatableField(parent.role, field)) {
      checkRepeatableFieldLimit(parent, field);
    } else if (scalarFieldsFor(owner).has(field)) {
      reject("malformed", "duplicate_field");
    }
    stack.push({ role: "scalar", owner, field, parts: [], textLength: 0, hasChild: false });
  });

  parser.on("closetag", () => {
    const frame = stack.pop();
    if (frame === undefined) reject("malformed", "invalid_xml");
    switch (frame.role) {
      case "scalar":
        if (frame.hasChild) reject("malformed", "invalid_structure");
        storeScalar(frame.owner, frame.field, frame.parts.join(""), budget);
        break;
      case "geocode":
        frame.area.geocodes.push(finalizeGeocode(frame.geocode));
        break;
      case "area":
        frame.info.areas.push(finalizeArea(frame.area));
        break;
      case "info":
        if (alertBuilder === null) reject("malformed", "invalid_structure");
        alertBuilder.infos.push(finalizeInfo(frame.info));
        break;
      case "root":
        if (alertBuilder === null) reject("malformed", "invalid_structure");
        resultMessage = finalizeAlert(alertBuilder, retrievedAt);
        rootClosed = true;
        break;
      case "ignored":
        break;
    }
  });

  parser.write(xmlText).close();
  if (!rootClosed || resultMessage === null || stack.length !== 0) {
    return failure("malformed", "invalid_xml");
  }
  return { kind: "message", message: resultMessage };
}

function acceptCharacterData(text: string, stack: readonly Frame[], budget: ParseBudget): void {
  addTextBudget(budget, text.length);
  const frame = stack.at(-1);
  if (frame === undefined) {
    if (!isXmlWhitespace(text)) reject("malformed", "invalid_structure");
    return;
  }
  if (frame.role === "ignored") return;
  if (frame.role === "scalar") {
    frame.textLength += text.length;
    const limit = frame.field === "polygon"
      ? BMKG_CAP_LIMITS.maxPolygonCharacters
      : BMKG_CAP_LIMITS.maxFieldCharacters;
    if (frame.textLength > limit) reject("unsupported", "field_limit_exceeded");
    frame.parts.push(text);
    return;
  }
  if (!isXmlWhitespace(text)) reject("malformed", "invalid_structure");
}

function addTextBudget(budget: ParseBudget, amount: number): void {
  budget.textCharacters += amount;
  if (budget.textCharacters > BMKG_CAP_LIMITS.maxTextCharacters) {
    reject("unsupported", "text_limit_exceeded");
  }
}

function readXmlLanguage(tag: SaxesTagNS): string | null {
  for (const attribute of Object.values(tag.attributes)) {
    if (attribute.uri === XML_NAMESPACE && attribute.local === "lang") {
      if (attribute.value.length > BMKG_CAP_LIMITS.maxFieldCharacters) {
        reject("unsupported", "field_limit_exceeded");
      }
      return attribute.value;
    }
  }
  return null;
}

function scalarFieldFor(role: Frame["role"], local: string | undefined): ScalarField | null {
  if (local === undefined) return null;
  if (role === "root" && isOneOf(local, [
    "identifier", "sender", "sent", "status", "msgType", "scope", "references", "incidents",
  ])) return local;
  if (role === "info" && isOneOf(local, [
    "category", "event", "urgency", "severity", "certainty", "effective", "onset", "expires",
    "headline", "description", "instruction", "web",
  ])) return local === "category" ? "category" : local;
  if (role === "area" && isOneOf(local, ["areaDesc", "polygon", "circle"])) return local;
  if (role === "geocode" && isOneOf(local, ["valueName", "value"])) return local;
  return null;
}

function scalarOwner(frame: Exclude<Frame, { role: "scalar" } | { role: "ignored" }>): ScalarOwner {
  switch (frame.role) {
    case "root": return frame.alert;
    case "info": return frame.info;
    case "area": return frame.area;
    case "geocode": return frame.geocode;
  }
}

function scalarFieldsFor(owner: ScalarOwner): Map<ScalarField, string> {
  return owner.scalarFields as Map<ScalarField, string>;
}

function isRepeatableField(role: Frame["role"], field: ScalarField): boolean {
  return (role === "info" && field === "category")
    || (role === "area" && (field === "polygon" || field === "circle"));
}

function checkRepeatableFieldLimit(frame: Exclude<Frame, { role: "scalar" } | { role: "ignored" }>, field: ScalarField): void {
  if (frame.role === "info" && field === "category"
    && frame.info.categories.length >= BMKG_CAP_LIMITS.maxCategoriesPerInfo) {
    reject("unsupported", "field_limit_exceeded");
  }
  if (frame.role === "area" && field === "polygon"
    && frame.area.polygons.length >= BMKG_CAP_LIMITS.maxPolygonsPerArea) {
    reject("unsupported", "polygon_limit_exceeded");
  }
  if (frame.role === "area" && field === "circle"
    && frame.area.circles.length >= BMKG_CAP_LIMITS.maxCirclesPerArea) {
    reject("unsupported", "circle_limit_exceeded");
  }
}

function storeScalar(owner: ScalarOwner, field: ScalarField, value: string, budget: ParseBudget): void {
  if (owner === null) reject("malformed", "invalid_structure");
  if (isInfoBuilder(owner) && field === "category") {
    owner.categories.push(parseCategory(value));
    return;
  }
  if (isAreaBuilder(owner) && field === "polygon") {
    owner.polygons.push(parsePolygon(value, budget));
    return;
  }
  if (isAreaBuilder(owner) && field === "circle") {
    owner.circles.push(value);
    return;
  }
  (owner.scalarFields as Map<ScalarField, string>).set(field, value);
}

function finalizeAlert(alert: AlertBuilder, retrievedAt: string): Cap12Message {
  const identifier = requiredField(alert.scalarFields, "identifier");
  const sender = requiredField(alert.scalarFields, "sender");
  const sent = requiredField(alert.scalarFields, "sent");
  const status = requiredField(alert.scalarFields, "status");
  const messageType = requiredField(alert.scalarFields, "msgType");
  const scope = requiredField(alert.scalarFields, "scope");

  if (identifier.length > BMKG_CAP_LIMITS.maxIdentifierCharacters
    || sender.length > BMKG_CAP_LIMITS.maxIdentifierCharacters
    || !isCapIdentifier(identifier)
    || !isCapIdentifier(sender)) reject("malformed", "invalid_field_value");
  if (!isCapDateTime(sent)) reject("malformed", "invalid_datetime");
  const references = alert.scalarFields.get("references") ?? null;
  const incidents = alert.scalarFields.get("incidents") ?? null;
  if (references !== null && !isValidReferences(references)) reject("malformed", "invalid_field_value");
  if (incidents !== null && !isValidIncidents(incidents)) reject("malformed", "invalid_field_value");

  return {
    identifier,
    sender,
    sent,
    status: parseEnum(status, ["Actual", "Exercise", "System", "Test", "Draft"]),
    messageType: parseEnum(messageType, ["Alert", "Update", "Cancel", "Ack", "Error"]),
    scope: parseEnum(scope, ["Public", "Restricted", "Private"]),
    references,
    incidents,
    retrievedAt,
    infos: alert.infos,
  };
}

function finalizeInfo(info: InfoBuilder): CapInfo {
  const event = requiredField(info.scalarFields, "event");
  if (info.categories.length === 0) reject("malformed", "missing_required_field");
  const effective = optionalDateTime(info.scalarFields, "effective");
  const onset = optionalDateTime(info.scalarFields, "onset");
  const expires = optionalDateTime(info.scalarFields, "expires");
  return {
    language: info.language,
    categories: info.categories,
    event,
    urgency: parseEnum(requiredField(info.scalarFields, "urgency"), [
      "Immediate", "Expected", "Future", "Past", "Unknown",
    ]),
    severity: parseEnum(requiredField(info.scalarFields, "severity"), [
      "Extreme", "Severe", "Moderate", "Minor", "Unknown",
    ]),
    certainty: parseEnum(requiredField(info.scalarFields, "certainty"), [
      "Observed", "Likely", "Possible", "Unlikely", "Unknown", "Very Likely",
    ]),
    effective,
    onset,
    expires,
    headline: info.scalarFields.get("headline") ?? null,
    description: info.scalarFields.get("description") ?? null,
    instruction: info.scalarFields.get("instruction") ?? null,
    web: info.scalarFields.get("web") ?? null,
    areas: info.areas,
  };
}

function finalizeArea(area: AreaBuilder): CapArea {
  return {
    description: requiredField(area.scalarFields, "areaDesc"),
    geocodes: area.geocodes,
    circles: area.circles,
    polygons: area.polygons,
  };
}

function finalizeGeocode(geocode: GeocodeBuilder): CapGeocode {
  return {
    valueName: requiredField(geocode.scalarFields, "valueName"),
    value: requiredField(geocode.scalarFields, "value"),
  };
}

function optionalDateTime(fields: Map<InfoScalarField, string>, field: "effective" | "onset" | "expires"): string | null {
  const value = fields.get(field);
  if (value === undefined) return null;
  if (!isCapDateTime(value)) reject("malformed", "invalid_datetime");
  return value;
}

function parsePolygon(sourceText: string, budget: ParseBudget): CapPolygon {
  const trimmed = sourceText.trim();
  if (trimmed.length === 0) reject("malformed", "invalid_polygon");
  const pairs = trimmed.split(/[\t\n\r ]+/u);
  if (pairs.length < 4) reject("malformed", "invalid_polygon");
  const coordinates: CapCrs84Position[] = [];
  for (const pair of pairs) {
    budget.coordinatePairs += 1;
    if (budget.coordinatePairs > BMKG_CAP_LIMITS.maxCoordinatePairs) {
      reject("unsupported", "coordinate_limit_exceeded");
    }
    const parsed = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)),([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/u.exec(pair);
    if (parsed === null) reject("malformed", "invalid_polygon");
    const latitude = Number(parsed[1]);
    const longitude = Number(parsed[2]);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      reject("malformed", "invalid_polygon");
    }
    coordinates.push([longitude, latitude]);
  }
  const first = coordinates[0]!;
  const last = coordinates[coordinates.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) reject("malformed", "invalid_polygon");
  return { sourceText, coordinates };
}

function parseCategory(value: string): CapCategory {
  return parseEnum(value, [
    "Geo", "Met", "Safety", "Security", "Rescue", "Fire", "Health", "Env", "Transport", "Infra", "CBRNE", "Other",
  ]);
}

function parseEnum<const Values extends readonly string[]>(value: string, values: Values): Values[number] {
  if ((values as readonly string[]).includes(value)) return value as Values[number];
  reject("malformed", "invalid_field_value");
}

function requiredField<Fields extends string>(fields: Map<Fields, string>, field: Fields): string {
  const value = fields.get(field);
  if (value === undefined || value.trim().length === 0) reject("malformed", "missing_required_field");
  return value;
}

function isCapIdentifier(value: string): boolean {
  return value.length > 0 && !/[\s,&<]/u.test(value);
}

function isValidReferences(value: string): boolean {
  const references = value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/gu, "");
  if (references.length === 0) return false;
  return references.split(/[\t\n\r ]+/u).every((reference) => {
    const parts = reference.split(",");
    return parts.length === 3
      && parts[0]!.length <= BMKG_CAP_LIMITS.maxIdentifierCharacters
      && parts[1]!.length <= BMKG_CAP_LIMITS.maxIdentifierCharacters
      && isCapIdentifier(parts[0]!)
      && isCapIdentifier(parts[1]!)
      && isCapDateTime(parts[2]!);
  });
}

function isValidIncidents(value: string): boolean {
  let index = 0;
  let count = 0;
  while (index < value.length) {
    while (isCapWhitespace(value[index])) index += 1;
    if (index >= value.length) break;
    if (value[index] === '"') {
      index += 1;
      const start = index;
      while (index < value.length && value[index] !== '"') index += 1;
      if (index >= value.length || value.slice(start, index).replace(/[\t\n\r ]/gu, "").length === 0) {
        return false;
      }
      index += 1;
      if (index < value.length && !isCapWhitespace(value[index])) return false;
    } else {
      const start = index;
      while (index < value.length && !isCapWhitespace(value[index])) {
        if (value[index] === '"') return false;
        index += 1;
      }
      if (index === start) return false;
    }
    count += 1;
  }
  return count > 0;
}

function isCapWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t" || character === "\r" || character === "\n";
}

function isCapDateTime(value: string): boolean {
  return isValidCalendarDateTime(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/u);
}

function isValidRetrievedAt(value: string): boolean {
  return value.length <= BMKG_CAP_LIMITS.maxRetrievedAtCharacters
    && isValidCalendarDateTime(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u);
}

function isValidCalendarDateTime(value: string, pattern: RegExp): boolean {
  const match = pattern.exec(value);
  if (match === null) return false;
  const datePart = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/u.exec(value);
  if (datePart === null) return false;
  const year = Number(datePart[1]);
  const month = Number(datePart[2]);
  const day = Number(datePart[3]);
  const hour = Number(datePart[4]);
  const minute = Number(datePart[5]);
  const second = Number(datePart[6]);
  if (year === 0 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysPerMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysPerMonth[month - 1]!) return false;

  const offset = value.endsWith("Z") ? null : value.slice(-6);
  if (offset !== null) {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function isXmlWhitespace(value: string): boolean {
  return /^[\t\n\r ]*$/u.test(value);
}

function isOneOf<const Values extends readonly string[]>(value: string, values: Values): value is Values[number] {
  return (values as readonly string[]).includes(value);
}

function isInfoBuilder(owner: ScalarOwner): owner is InfoBuilder {
  return "categories" in owner;
}

function isAreaBuilder(owner: ScalarOwner): owner is AreaBuilder {
  return "polygons" in owner;
}

function reject(kind: ErrorKind, code: CapParseErrorCode): never {
  throw new CapParseFailure(kind, code);
}

function failure(kind: ErrorKind, code: CapParseErrorCode): CapParseResult {
  return { kind: "error", error: { kind, code } };
}
