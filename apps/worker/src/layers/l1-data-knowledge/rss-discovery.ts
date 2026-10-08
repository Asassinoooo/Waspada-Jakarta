import { SaxesParser } from "saxes";
import type { SaxesTagNS } from "saxes";

export const RSS_DISCOVERY_LIMITS = {
  maxInputBytes: 1_048_576,
  maxElements: 10_000,
  maxDepth: 32,
  maxTextCharacters: 524_288,
  maxItems: 500,
  maxTitleCharacters: 512,
  maxLinkCharacters: 2_048,
  maxGuidCharacters: 512,
  maxPubDateCharacters: 128,
  maxRetrievedAtCharacters: 64,
} as const;

export interface RssDiscoveryItem {
  readonly title: string | null;
  readonly link: string | null;
  readonly guid: string | null;
  /** Raw source text only; pubDate is not an incident or observation time. */
  readonly pubDate: string | null;
}

export type RssDiscoveryErrorCode =
  | "invalid_retrieved_at"
  | "input_too_large"
  | "invalid_xml"
  | "doctype_forbidden"
  | "invalid_root"
  | "unsupported_version"
  | "invalid_structure"
  | "duplicate_field"
  | "element_limit_exceeded"
  | "depth_limit_exceeded"
  | "text_limit_exceeded"
  | "item_limit_exceeded"
  | "field_limit_exceeded";

export type RssDiscoveryParseResult =
  | { readonly kind: "feed"; readonly retrievedAt: string; readonly items: readonly RssDiscoveryItem[] }
  | { readonly kind: "error"; readonly error: { readonly code: RssDiscoveryErrorCode } };

type ExtractedField = "title" | "link" | "guid" | "pubDate";

interface ItemBuilder {
  readonly seen: Set<ExtractedField>;
  readonly fields: Partial<Record<ExtractedField, string>>;
}

type Frame =
  | { readonly role: "rss" }
  | { readonly role: "channel" }
  | { readonly role: "item"; readonly item: ItemBuilder }
  | {
      readonly role: "scalar";
      readonly item: ItemBuilder;
      readonly field: ExtractedField;
      readonly parts: string[];
      textCharacters: number;
      hasChild: boolean;
    }
  | { readonly role: "ignored" };

interface ParseBudget {
  elements: number;
  textCharacters: number;
  items: number;
}

class RssParseFailure extends Error {
  constructor(readonly code: RssDiscoveryErrorCode) {
    super(code);
  }
}

/**
 * Pure parser for caller-buffered RSS 2.0 XML. It does not fetch, persist,
 * identify a publisher, authorize reuse, verify an event, or establish freshness.
 */
export function parseRssDiscoveryXml(xmlText: string, retrievedAt: string): RssDiscoveryParseResult {
  if (typeof retrievedAt !== "string" || !isValidRetrievedAt(retrievedAt)) {
    return failure("invalid_retrieved_at");
  }
  if (typeof xmlText !== "string") return failure("invalid_xml");
  if (xmlText.length > RSS_DISCOVERY_LIMITS.maxInputBytes) return failure("input_too_large");
  if (new TextEncoder().encode(xmlText).byteLength > RSS_DISCOVERY_LIMITS.maxInputBytes) {
    return failure("input_too_large");
  }
  try {
    return parseXml(xmlText, retrievedAt);
  } catch (error) {
    if (error instanceof RssParseFailure) return failure(error.code);
    // Parser diagnostics may include source excerpts or positions; never expose them.
    return failure("invalid_xml");
  }
}

function parseXml(xmlText: string, retrievedAt: string): RssDiscoveryParseResult {
  const parser = new SaxesParser({ xmlns: true, position: false });
  const stack: Frame[] = [];
  const budget: ParseBudget = { elements: 0, textCharacters: 0, items: 0 };
  const items: RssDiscoveryItem[] = [];
  let rootOpened = false;
  let rootClosed = false;
  let channelSeen = false;

  parser.on("error", () => reject("invalid_xml"));
  parser.on("doctype", () => reject("doctype_forbidden"));
  parser.on("comment", (comment) => addTextBudget(budget, comment.length));
  parser.on("processinginstruction", (instruction) => {
    addTextBudget(budget, instruction.target.length + instruction.body.length);
  });
  parser.on("text", (text) => acceptCharacterData(text, stack, budget));
  parser.on("cdata", (text) => acceptCharacterData(text, stack, budget));
  parser.on("xmldecl", (declaration) => {
    if (declaration.encoding !== undefined && declaration.encoding.toLowerCase() !== "utf-8") {
      reject("invalid_xml");
    }
  });

  parser.on("opentag", (tag: SaxesTagNS) => {
    budget.elements += 1;
    if (budget.elements > RSS_DISCOVERY_LIMITS.maxElements) reject("element_limit_exceeded");
    if (stack.length + 1 > RSS_DISCOVERY_LIMITS.maxDepth) reject("depth_limit_exceeded");
    for (const attribute of Object.values(tag.attributes)) addTextBudget(budget, attribute.value.length);

    const parent = stack.at(-1);
    if (parent === undefined) {
      if (rootOpened || rootClosed) reject("invalid_structure");
      if (tag.local !== "rss" || tag.uri !== "") reject("invalid_root");
      const version = tag.attributes.version;
      if (version === undefined || version.uri !== "" || version.value !== "2.0") {
        reject("unsupported_version");
      }
      rootOpened = true;
      stack.push({ role: "rss" });
      return;
    }
    if (parent.role === "ignored") {
      stack.push({ role: "ignored" });
      return;
    }
    if (parent.role === "scalar") {
      parent.hasChild = true;
      stack.push({ role: "ignored" });
      return;
    }
    if (parent.role === "rss") {
      if (tag.uri !== "") {
        stack.push({ role: "ignored" });
        return;
      }
      if (tag.local !== "channel" || channelSeen) reject("invalid_structure");
      channelSeen = true;
      stack.push({ role: "channel" });
      return;
    }
    if (parent.role === "channel") {
      if (tag.uri !== "") {
        stack.push({ role: "ignored" });
        return;
      }
      if (tag.local === "item") {
        budget.items += 1;
        if (budget.items > RSS_DISCOVERY_LIMITS.maxItems) reject("item_limit_exceeded");
        stack.push({ role: "item", item: { seen: new Set(), fields: {} } });
        return;
      }
      // Channel metadata such as title, image and description is not returned.
      stack.push({ role: "ignored" });
      return;
    }
    if (parent.role === "item") {
      if (tag.uri !== "") {
        stack.push({ role: "ignored" });
        return;
      }
      const field = extractedField(tag.local);
      if (field === null) {
        // Descriptions, enclosures and other bodies remain excluded.
        stack.push({ role: "ignored" });
        return;
      }
      if (parent.item.seen.has(field)) reject("duplicate_field");
      parent.item.seen.add(field);
      stack.push({
        role: "scalar",
        item: parent.item,
        field,
        parts: [],
        textCharacters: 0,
        hasChild: false,
      });
      return;
    }
    reject("invalid_structure");
  });

  parser.on("closetag", () => {
    const frame = stack.pop();
    if (frame === undefined) reject("invalid_xml");
    switch (frame.role) {
      case "scalar":
        if (frame.hasChild) reject("invalid_structure");
        frame.item.fields[frame.field] = frame.parts.join("");
        break;
      case "item":
        items.push(finalizeItem(frame.item));
        break;
      case "rss":
        if (!channelSeen) reject("invalid_structure");
        rootClosed = true;
        break;
      case "channel":
      case "ignored":
        break;
    }
  });

  parser.write(xmlText).close();
  if (!rootOpened || !rootClosed || !channelSeen || stack.length !== 0) return failure("invalid_xml");
  return { kind: "feed", retrievedAt, items };
}

function acceptCharacterData(text: string, stack: readonly Frame[], budget: ParseBudget): void {
  addTextBudget(budget, text.length);
  const frame = stack.at(-1);
  if (frame === undefined || frame.role === "rss" || frame.role === "channel" || frame.role === "item") {
    if (!/^[\t\n\r ]*$/u.test(text)) reject("invalid_structure");
    return;
  }
  if (frame.role === "ignored") return;
  frame.textCharacters += text.length;
  if (frame.textCharacters > fieldLimit(frame.field)) reject("field_limit_exceeded");
  frame.parts.push(text);
}

function addTextBudget(budget: ParseBudget, amount: number): void {
  budget.textCharacters += amount;
  if (budget.textCharacters > RSS_DISCOVERY_LIMITS.maxTextCharacters) reject("text_limit_exceeded");
}

function extractedField(localName: string): ExtractedField | null {
  switch (localName) {
    case "title":
    case "link":
    case "guid":
    case "pubDate":
      return localName;
    default:
      return null;
  }
}

function fieldLimit(field: ExtractedField): number {
  switch (field) {
    case "title":
      return RSS_DISCOVERY_LIMITS.maxTitleCharacters;
    case "link":
      return RSS_DISCOVERY_LIMITS.maxLinkCharacters;
    case "guid":
      return RSS_DISCOVERY_LIMITS.maxGuidCharacters;
    case "pubDate":
      return RSS_DISCOVERY_LIMITS.maxPubDateCharacters;
  }
}

function finalizeItem(item: ItemBuilder): RssDiscoveryItem {
  return {
    title: item.fields.title ?? null,
    link: item.fields.link ?? null,
    guid: item.fields.guid ?? null,
    pubDate: item.fields.pubDate ?? null,
  };
}

function isValidRetrievedAt(value: string): boolean {
  if (value.length > RSS_DISCOVERY_LIMITS.maxRetrievedAtCharacters) return false;
  const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
  if (!pattern.test(value)) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/u.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
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

function reject(code: RssDiscoveryErrorCode): never {
  throw new RssParseFailure(code);
}

function failure(code: RssDiscoveryErrorCode): RssDiscoveryParseResult {
  return { kind: "error", error: { code } };
}
