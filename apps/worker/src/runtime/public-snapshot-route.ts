import type { EventPage } from "../contracts/public-api.js";
import {
  createPublicEventListPageService,
} from "../layers/l4-application-integration/public-event-list-page-service.js";
import type { PublicEventListCursorCodec } from "../layers/l4-application-integration/public-event-list-cursor.js";
import { parsePublicEventListQuery } from "../layers/l4-application-integration/public-event-list-query.js";
import {
  createPublicSnapshotListProjection,
  newPublicSnapshotTiming,
  shortDigest,
  type PublicSnapshot,
  type PublicSnapshotStore,
  type PublicSnapshotTiming,
} from "./public-snapshot.js";

/**
 * PERF-03: the three hosted public reads that the KV snapshot can answer. Only these routes get the public cache
 * headers. Every other route keeps `cache-control: no-store`.
 */
export type PublicSnapshotRouteKind = "list" | "detail" | "geojson";

export const PUBLIC_READ_CACHE_CONTROL = "public, max-age=15, stale-while-revalidate=30";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const GEOJSON_CONTENT_TYPE = "application/geo+json";
const EVENTS_PATH_PREFIX = "/api/v1/events/";

export interface PublicSnapshotRouteSelection {
  readonly method: string;
  readonly pathname: string;
  readonly datasetMode?: string;
  /** The PUBLIC_SNAPSHOT binding. Absent means the route behaves exactly as before PERF-03. */
  readonly snapshotBinding?: unknown;
  /** True when the live database is configured (the SQL executor or the fresh Hyperdrive config). */
  /** A function is called only after the cheaper checks pass, so other routes never read the database binding. */
  readonly databaseConfigured: boolean | (() => boolean);
}

/** Selects the route only for a live GET of one of the three reads, with the binding and a database present. */
export function publicSnapshotRouteFor(selection: PublicSnapshotRouteSelection): PublicSnapshotRouteKind | null {
  if (selection.method !== "GET"
    || selection.datasetMode !== "live"
    || selection.snapshotBinding === undefined) {
    return null;
  }
  let kind: PublicSnapshotRouteKind | null = null;
  if (selection.pathname === "/api/v1/events") kind = "list";
  else if (selection.pathname === "/api/v1/events.geojson") kind = "geojson";
  else if (/^\/api\/v1\/events\/[^/]*$/u.test(selection.pathname)) kind = "detail";
  if (kind === null) return null;
  const configured = typeof selection.databaseConfigured === "function"
    ? selection.databaseConfigured()
    : selection.databaseConfigured;
  return configured ? kind : null;
}

export interface PublicSnapshotRouteOptions {
  readonly store: PublicSnapshotStore;
  /** Needed for list pages (the cursor HMAC key). Without it the list falls back to the DB path. */
  readonly cursorCodec: PublicEventListCursorCodec | undefined;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

interface ServedBody {
  readonly contentType: string;
  readonly body: string;
  readonly etag: string;
}

/**
 * Answers one of the three reads. The snapshot answers when it can reproduce the DB response exactly. Otherwise
 * (no snapshot, a filtered list, an id the snapshot does not hold, a rejected request) the DB path answers, so its
 * status and error body stay as they are. Either way the 200 response carries the public cache headers and a weak ETag.
 */
export async function readPublicSnapshotRoute(
  request: Request,
  kind: PublicSnapshotRouteKind,
  options: PublicSnapshotRouteOptions,
  readFromDatabase: () => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  const startedAt = performance.now();
  const timing = newPublicSnapshotTiming();
  const snapshot = await options.store
    .read({
      ...(options.waitUntil === undefined ? {} : { waitUntil: options.waitUntil }),
      timing,
    })
    .catch(() => null);
  const served = snapshot === null ? null : await answerFromSnapshot(kind, url, snapshot, options.cursorCodec);
  if (served !== null) {
    return publicReadResponse(request, served, snapshotServerTiming(timing, performance.now() - startedAt));
  }

  const response = await readFromDatabase();
  if (response.status !== 200) return response;
  const body = await response.text();
  return publicReadResponse(request, {
    contentType: response.headers.get("content-type") ?? JSON_CONTENT_TYPE,
    body,
    etag: await shortDigest(body),
  });
}

async function answerFromSnapshot(
  kind: PublicSnapshotRouteKind,
  url: URL,
  snapshot: PublicSnapshot,
  cursorCodec: PublicEventListCursorCodec | undefined,
): Promise<ServedBody | null> {
  const hash16 = snapshot.content_hash.slice(0, 16);
  if (kind === "detail") {
    let eventId: string;
    try {
      eventId = decodeURIComponent(url.pathname.slice(EVENTS_PATH_PREFIX.length));
    } catch {
      return null;
    }
    // Snapshot ids are valid ids, so a held id is one the DB path would accept. An absent id goes to the DB.
    if (!Object.hasOwn(snapshot.details, eventId)) return null;
    return { contentType: JSON_CONTENT_TYPE, body: JSON.stringify(snapshot.details[eventId]), etag: hash16 };
  }

  if (kind === "geojson") {
    if (snapshot.geojson === null || [...url.searchParams.keys()].length > 0) return null;
    return { contentType: GEOJSON_CONTENT_TYPE, body: JSON.stringify(snapshot.geojson), etag: hash16 };
  }

  if (cursorCodec === undefined) return null;
  try {
    const query = parsePublicEventListQuery(url.searchParams);
    if (Object.keys(query.filters).length > 0) return null;
    const pages = createPublicEventListPageService({
      projection: createPublicSnapshotListProjection(snapshot),
      cursorCodec,
    });
    const page: EventPage = await pages.read(url.searchParams);
    return {
      contentType: JSON_CONTENT_TYPE,
      body: JSON.stringify(page),
      etag: `${hash16}-${await shortDigest(url.search)}`,
    };
  } catch {
    return null;
  }
}

/**
 * PERF-08: the Server-Timing value of a snapshot answer, for example
 * `snap;desc="kv", kv;dur=3.2, db;dur=0, build;dur=0, total;dur=5.1`. The source is one of four fixed words and every
 * duration is a rounded number, so the value never carries SQL, keys, URLs, ids or error text.
 */
export function snapshotServerTiming(timing: PublicSnapshotTiming, totalMs: number): string {
  const duration = (value: number): string => String(Number.isFinite(value) ? Math.max(0, Math.round(value * 10) / 10) : 0);
  // The store sets a source before it returns any snapshot, so the fallback only keeps the type total.
  return [
    `snap;desc="${timing.source ?? "memo"}"`,
    `kv;dur=${duration(timing.kvMs)}`,
    `db;dur=${duration(timing.dbMs)}`,
    `build;dur=${duration(timing.buildMs)}`,
    `total;dur=${duration(totalMs)}`,
  ].join(", ");
}

/**
 * Public cache headers and the weak ETag on a 200. A matching If-None-Match gets a 304 with no body. A snapshot answer
 * also carries its Server-Timing, on the 200 and on the 304.
 */
function publicReadResponse(request: Request, served: ServedBody, serverTiming?: string): Response {
  const headers: Record<string, string> = {
    "content-type": served.contentType,
    "x-content-type-options": "nosniff",
    "cache-control": PUBLIC_READ_CACHE_CONTROL,
    etag: `W/"${served.etag}"`,
  };
  if (serverTiming !== undefined) headers["server-timing"] = serverTiming;
  if (ifNoneMatchMatches(request.headers.get("if-none-match"), served.etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(served.body, { status: 200, headers });
}

/** Weak comparison against a list of entity tags, or `*`. */
function ifNoneMatchMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  if (header.trim() === "*") return true;
  const opaque = `"${etag}"`;
  return header.split(",").some((candidate) => candidate.trim().replace(/^W\//u, "") === opaque);
}
