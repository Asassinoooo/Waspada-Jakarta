import type { EventDetail, EventView, PublicFeatureCollection } from "../contracts/public-api.js";
import { createPublicEventGeometriesRepository } from "../../../db/src/public-event-geometries.js";
import { createPublicEventListRepository, type PublicEventListPage } from "../../../db/src/public-event-list.js";
import { createPublicEventSnapshotRepository } from "../../../db/src/public-event-snapshot.js";
import { createPublicProjectionLookupRepository, PUBLIC_PROJECTION_LOOKUP_LIMITS } from "../../../db/src/public-projection-lookups.js";
import type { SqlExecutor } from "../../../db/src/sql.js";
import { createPublicEventDetailProjectionService } from "../layers/l4-application-integration/public-event-detail-projection-service.js";
import { createPublicEventProjectionService } from "../layers/l4-application-integration/public-event-projection-service.js";
import {
  createPublicEventListProjectionService,
  PUBLIC_EVENT_LIST_PROJECTION_LIMITS,
  type PublicEventListCursor,
  type PublicEventListProjectionResult,
} from "../layers/l4-application-integration/public-event-list-projection-service.js";
import { readPublicGeoJSONQuery } from "../layers/l4-application-integration/public-geojson-query.js";
import { readCollection as readGeoJSONCollection } from "./public-event-geojson-runtime.js";

/**
 * PERF-03 (owner accepted at most 60 s of staleness for public reads). The hosted public reads of the event list,
 * one event and the GeoJSON collection are served from one published snapshot in Cloudflare KV. The snapshot holds
 * exactly what the DB path returns, built by the existing candidate reader, list projection, detail projection and
 * GeoJSON reader. A public read then needs no database connection.
 *
 * A check costs one statement: the fingerprint over every public view the snapshot reads. A full rebuild runs only
 * when that fingerprint changed (or a hook forces it). The projections read no clock and no other table, so equal
 * fingerprints mean the same snapshot. PUBLIC_SNAPSHOT_VERSION must change when projection output changes shape,
 * because the fingerprint cannot see code changes.
 */
export const PUBLIC_SNAPSHOT_VERSION = 1;
export const PUBLIC_SNAPSHOT_KEY = "public-snapshot:v1";

/** In-isolate memo lifetime: a KV read happens at most this often per isolate. */
const DEFAULT_MEMO_TTL_MS = 15_000;
/** A snapshot verified longer ago than this gets one fingerprint check, run in the background. */
const DEFAULT_STALE_AFTER_MS = 30_000;
/** Beyond this the read runs the fingerprint check before it answers, so a served snapshot is never older than 60 s. */
const DEFAULT_HARD_STALE_AFTER_MS = 60_000;
/** Safety cap on the candidate walk. The DB reader pages in order, so the walk always ends. */
const MAX_SNAPSHOT_CANDIDATES = 20_000;

/**
 * The change fingerprint: one statement over every public view the snapshot reads. Each row is hashed as its text, so a
 * new version, a withdrawal, a freshness change, an impact, geometry, attribution, scope name or location label change
 * moves the value. It names only views the build already reads, so it needs no new grant. The views are security
 * barrier views, read with the same executor as the build.
 */
export const PUBLIC_SNAPSHOT_FINGERPRINT_SQL = `
SELECT count(*)::text || ':' || coalesce(md5(string_agg(part, ',' ORDER BY part)), '') AS fingerprint
FROM (
  SELECT 'events:' || md5(view_row::text) AS part FROM waspada.public_event_versions AS view_row
  UNION ALL SELECT 'impacts:' || md5(view_row::text) FROM waspada.public_event_impacts AS view_row
  UNION ALL SELECT 'location:' || md5(view_row::text) FROM waspada.public_event_location_status AS view_row
  UNION ALL SELECT 'scope_names:' || md5(view_row::text) FROM waspada.public_scope_names AS view_row
  UNION ALL SELECT 'attributions:' || md5(view_row::text) FROM waspada.public_source_attributions AS view_row
  UNION ALL SELECT 'geometries:' || md5(view_row::text) FROM waspada.public_event_geometries AS view_row
  UNION ALL SELECT 'geojson:' || md5(view_row::text) FROM waspada.public_event_geojson_candidates AS view_row
) AS parts`;

/** One statement. A missing row is an error, so a failed fingerprint never matches a stored one. */
export async function readPublicSnapshotFingerprint(executor: SqlExecutor): Promise<string> {
  const result = await executor.query<{ readonly fingerprint: string | null }>(PUBLIC_SNAPSHOT_FINGERPRINT_SQL);
  const value = result.rows[0]?.fingerprint;
  if (typeof value !== "string") throw new Error("public snapshot fingerprint is missing");
  return value;
}

/**
 * One candidate in the canonical list order. `view` is null when the strict projector skips the candidate. A skipped
 * candidate still takes its slot in the page window and in the continuation cursor, exactly as on the DB path.
 */
export interface PublicSnapshotListEntry {
  readonly firstPublishedAt: string;
  readonly eventId: string;
  readonly view: EventView | null;
}

export interface PublicSnapshotDraft {
  readonly events: readonly PublicSnapshotListEntry[];
  /** Detail DTOs by event id. An id absent here is answered by the DB path, so it is never a wrong answer. */
  readonly details: Readonly<Record<string, EventDetail>>;
  /** The unfiltered GeoJSON body, or null when it could not be built (the route then falls back to the DB). */
  readonly geojson: PublicFeatureCollection | null;
}

export interface PublicSnapshot extends PublicSnapshotDraft {
  readonly version: typeof PUBLIC_SNAPSHOT_VERSION;
  /** UTC ISO time of the build that wrote this content. Only a rebuild moves it. */
  readonly built_at: string;
  /** The fingerprint read before this build. A later check whose fingerprint matches needs no rebuild. */
  readonly fingerprint: string;
  readonly content_hash: string;
}

/** The subset of the Workers KV binding the snapshot uses. */
export interface PublicSnapshotKvNamespace {
  get(key: string, type: "text"): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/**
 * How one read was answered. `memo`: this isolate's memo, with no KV read and no statement. `kv`: the KV snapshot, with
 * no statement. `check`: a synchronous fingerprint check matched the content. `rebuild`: a full build ran.
 */
export type PublicSnapshotSource = "memo" | "kv" | "check" | "rebuild";

/**
 * PERF-08: filled in by one read, so the route can report it in Server-Timing. Durations are milliseconds of this read's
 * own work. `kvMs` is the KV get and parse. `dbMs` is the fingerprint statement plus the rebuild's database callback
 * (connection, statements and the projection that runs inside it). `buildMs` is the content hash and snapshot assembly.
 * A stage this read did not run stays at 0. The background check and the KV write are not counted.
 */
export interface PublicSnapshotTiming {
  source: PublicSnapshotSource | null;
  kvMs: number;
  dbMs: number;
  buildMs: number;
}

export function newPublicSnapshotTiming(): PublicSnapshotTiming {
  return { source: null, kvMs: 0, dbMs: 0, buildMs: 0 };
}

export interface PublicSnapshotReadOptions {
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  /** Receives how this read was answered. Optional: without it the read behaves exactly as before PERF-08. */
  readonly timing?: PublicSnapshotTiming;
}

function elapsedSince(startedAt: number): number {
  return performance.now() - startedAt;
}

export interface PublicSnapshotStore {
  /** The snapshot to answer from, or null when none can be had (the caller then answers from the DB). */
  read(options?: PublicSnapshotReadOptions): Promise<PublicSnapshot | null>;
  /** Rebuilds now, whatever the fingerprint says, and writes KV. Used by the moderator, auto-publish and refresh hooks. */
  refresh(): Promise<PublicSnapshot | null>;
}

export interface PublicSnapshotStoreOptions {
  readonly kv: PublicSnapshotKvNamespace;
  /** Runs one database operation. Production uses the no-cache config, so a check sees the latest committed write. */
  readonly withExecutor: <Result>(operation: (executor: SqlExecutor) => Promise<Result>) => Promise<Result>;
  readonly now?: () => number;
  readonly memoTtlMs?: number;
  readonly staleAfterMs?: number;
  readonly hardStaleAfterMs?: number;
}

/** Thrown by the snapshot list projection for a filtered request. The route checks first, so this is defensive. */
export class PublicSnapshotUnsupportedError extends Error {
  constructor() {
    super("The public snapshot does not answer filtered list requests.");
    this.name = "PublicSnapshotUnsupportedError";
  }
}

/**
 * Builds the snapshot content from the existing DB-backed services. Candidates come from the same bounded reader the
 * DB list uses, page by page in canonical order. Details are read in batches of the lookup limit (PERF-03), so a build
 * of up to 100 events takes a constant number of statements for the details.
 */
export async function buildPublicSnapshotDraft(executor: SqlExecutor): Promise<PublicSnapshotDraft> {
  const candidates = createPublicEventListRepository(executor);
  const eventProjection = createPublicEventProjectionService({
    snapshots: createPublicEventSnapshotRepository(executor),
    lookups: createPublicProjectionLookupRepository(executor),
  });

  const entries: PublicSnapshotListEntry[] = [];
  let cursor: PublicEventListCursor | undefined;
  for (;;) {
    const limit = PUBLIC_EVENT_LIST_PROJECTION_LIMITS.maxPageSize;
    // The page is read once here and handed to the list projection, which validates it and projects its events.
    const page: PublicEventListPage = await candidates.read(cursor === undefined ? { limit } : { limit, cursor });
    const projection = createPublicEventListProjectionService({
      candidates: { read: async () => page },
      projections: eventProjection,
    });
    const result: PublicEventListProjectionResult = await projection.read({
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const viewById = new Map(result.events.map((event) => [event.event_id, event] as const));
    for (const candidate of page.candidates) {
      entries.push({
        firstPublishedAt: candidate.firstPublishedAt,
        eventId: candidate.eventId,
        view: viewById.get(candidate.eventId) ?? null,
      });
    }
    if (entries.length > MAX_SNAPSHOT_CANDIDATES) throw new Error("public snapshot candidate limit exceeded");
    if (result.nextCursor === null) break;
    cursor = result.nextCursor;
  }

  const detailService = createPublicEventDetailProjectionService({
    snapshots: createPublicEventSnapshotRepository(executor),
    lookups: createPublicProjectionLookupRepository(executor),
    geometries: createPublicEventGeometriesRepository(executor),
  });
  const detailEntries: [string, EventDetail][] = [];
  const eventIds = entries.map((entry) => entry.eventId);
  const batchSize = PUBLIC_PROJECTION_LOOKUP_LIMITS.batchRequests;
  for (let start = 0; start < eventIds.length; start += batchSize) {
    const chunk = eventIds.slice(start, start + batchSize);
    // A chunk that fails is left out, so its ids are answered by the DB path. A non-found event is left out too.
    const outcomes = await detailService.readMany(chunk).catch(() => null);
    if (outcomes === null) continue;
    chunk.forEach((eventId, index) => {
      const outcome = outcomes[index];
      if (outcome !== undefined && "value" in outcome && outcome.value.kind === "found") {
        detailEntries.push([eventId, outcome.value.detail]);
      }
    });
  }

  let geojson: PublicFeatureCollection | null;
  try {
    geojson = await readGeoJSONCollection(executor, readPublicGeoJSONQuery(new URLSearchParams()));
  } catch {
    geojson = null;
  }

  return { events: entries, details: Object.fromEntries(detailEntries), geojson };
}

/** SHA-256 over the canonical JSON of the content. The build time is excluded, so it never changes the hash. */
export async function snapshotContentHash(draft: PublicSnapshotDraft): Promise<string> {
  return sha256Hex(JSON.stringify({ events: draft.events, details: draft.details, geojson: draft.geojson }));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The first 16 hex digits of SHA-256, the length the weak ETag carries. */
export async function shortDigest(text: string): Promise<string> {
  return (await sha256Hex(text)).slice(0, 16);
}

/**
 * Serves a list page from the snapshot, with the cursor rules of the DB list. The window starts after the cursor and
 * takes `limit` candidates. The continuation cursor is the last candidate of a window that has more after it.
 */
export function createPublicSnapshotListProjection(snapshot: PublicSnapshot): {
  read(request?: unknown): Promise<PublicEventListProjectionResult>;
} {
  return {
    async read(request) {
      const page = request as {
        readonly limit: number;
        readonly cursor?: PublicEventListCursor;
        readonly filters?: Readonly<Record<string, unknown>>;
      };
      if (page.filters !== undefined && Object.keys(page.filters).length > 0) {
        throw new PublicSnapshotUnsupportedError();
      }
      const entries = snapshot.events;
      const start = page.cursor === undefined ? 0 : firstIndexAfter(entries, page.cursor);
      const pageEntries = entries.slice(start, start + page.limit);
      const hasMore = start + page.limit < entries.length;
      const events: EventView[] = [];
      for (const entry of pageEntries) {
        if (entry.view !== null) events.push(entry.view);
      }
      const last = pageEntries.at(-1);
      return {
        events,
        nextCursor: hasMore && last !== undefined
          ? { firstPublishedAt: last.firstPublishedAt, eventId: last.eventId }
          : null,
      };
    },
  };
}

/** The first entry strictly after the cursor in the list order (newest first, then ascending event id). */
function firstIndexAfter(entries: readonly PublicSnapshotListEntry[], cursor: PublicEventListCursor): number {
  const index = entries.findIndex((entry) => entry.firstPublishedAt < cursor.firstPublishedAt
    || (entry.firstPublishedAt === cursor.firstPublishedAt && entry.eventId > cursor.eventId));
  return index === -1 ? entries.length : index;
}

interface SnapshotMemo {
  readonly snapshot: PublicSnapshot;
  /** When this isolate loaded or built the snapshot. The memo lives for memoTtlMs from here. */
  readonly loadedAt: number;
  /** When the content was last confirmed against the database (a matching fingerprint or a rebuild). Drives the stale rules. */
  readonly verifiedAt: number;
}

interface CheckMode {
  /** A refresh: the check rebuilds whatever the fingerprint says. */
  readonly force: boolean;
  /** True when KV had no usable snapshot, so the build must write it. */
  readonly kvMissing: boolean;
  /** The rebuild epoch when the miss was seen. A build that finished after the miss already holds the content. */
  readonly epochAtMiss?: number;
}

interface CheckResult {
  readonly snapshot: PublicSnapshot;
  /** Set only when a rebuild needs KV to get the new content. The caller passes it to waitUntil. */
  readonly write?: Promise<void>;
}

type LoadResult =
  | { readonly kind: "hit"; readonly snapshot: PublicSnapshot }
  | { readonly kind: "miss" }
  | { readonly kind: "error" };

/**
 * One store per isolate. Reads come from the in-isolate memo, then KV. Checks are serialised, so at most one runs in an
 * isolate. A check reads the fingerprint (one statement). Only a changed fingerprint, a forced refresh or a missing KV
 * snapshot runs the full build, and only a full build writes KV.
 */
export function createPublicSnapshotStore(options: PublicSnapshotStoreOptions): PublicSnapshotStore {
  const kv = options.kv;
  const withExecutor = options.withExecutor;
  const now = options.now ?? Date.now;
  const memoTtlMs = options.memoTtlMs ?? DEFAULT_MEMO_TTL_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const hardStaleAfterMs = options.hardStaleAfterMs ?? DEFAULT_HARD_STALE_AFTER_MS;

  let memo: SnapshotMemo | undefined;
  let rebuildEpoch = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let backgroundPending = false;

  async function writeSnapshot(snapshot: PublicSnapshot): Promise<void> {
    try {
      await kv.put(PUBLIC_SNAPSHOT_KEY, JSON.stringify(snapshot));
    } catch {
      // A failed write costs one more rebuild in another isolate. Reads never depend on it.
    }
  }

  async function checkNow(mode: CheckMode, timing: PublicSnapshotTiming): Promise<CheckResult> {
    const startedAt = now();
    if (!mode.force && !mode.kvMissing && memo !== undefined && startedAt - memo.verifiedAt <= staleAfterMs) {
      // A check that finished while this one waited in the queue already confirmed the content.
      timing.source = "memo";
      return { snapshot: memo.snapshot };
    }
    if (mode.kvMissing && memo !== undefined && mode.epochAtMiss !== undefined && rebuildEpoch !== mode.epochAtMiss) {
      // Concurrent cold reads share one build: a build that finished after the miss was seen wrote or will write KV.
      timing.source = "memo";
      return { snapshot: memo.snapshot };
    }
    const fingerprintStarted = performance.now();
    const fingerprint = await withExecutor((executor) => readPublicSnapshotFingerprint(executor));
    timing.dbMs += elapsedSince(fingerprintStarted);
    if (!mode.force && !mode.kvMissing && memo !== undefined && memo.snapshot.fingerprint === fingerprint) {
      // The fingerprint was read after startedAt, so startedAt is a safe, earlier verification time. KV is not written.
      memo = { ...memo, verifiedAt: startedAt };
      timing.source = "check";
      return { snapshot: memo.snapshot };
    }
    const draftStarted = performance.now();
    const draft = await withExecutor((executor) => buildPublicSnapshotDraft(executor));
    timing.dbMs += elapsedSince(draftStarted);
    const assembleStarted = performance.now();
    const snapshot: PublicSnapshot = {
      version: PUBLIC_SNAPSHOT_VERSION,
      built_at: new Date(startedAt).toISOString(),
      fingerprint,
      content_hash: await snapshotContentHash(draft),
      events: draft.events,
      details: draft.details,
      geojson: draft.geojson,
    };
    memo = { snapshot, loadedAt: startedAt, verifiedAt: startedAt };
    rebuildEpoch += 1;
    timing.buildMs += elapsedSince(assembleStarted);
    timing.source = "rebuild";
    return { snapshot, write: writeSnapshot(snapshot) };
  }

  function check(mode: CheckMode, timing: PublicSnapshotTiming = newPublicSnapshotTiming()): Promise<CheckResult> {
    const run = queue.then(() => checkNow(mode, timing));
    queue = run.catch(() => undefined);
    return run;
  }

  async function loadFromKv(): Promise<LoadResult> {
    let text: string | null;
    try {
      text = await kv.get(PUBLIC_SNAPSHOT_KEY, "text");
    } catch {
      return { kind: "error" };
    }
    if (text === null) return { kind: "miss" };
    const snapshot = parseSnapshot(text);
    return snapshot === null ? { kind: "miss" } : { kind: "hit", snapshot };
  }

  async function serveCheck(
    mode: CheckMode,
    readOptions: PublicSnapshotReadOptions,
    timing: PublicSnapshotTiming,
  ): Promise<PublicSnapshot | null> {
    let result: CheckResult;
    try {
      result = await check(mode, timing);
    } catch {
      return null;
    }
    if (result.write !== undefined) {
      if (readOptions.waitUntil) readOptions.waitUntil(result.write);
      else await result.write;
    }
    return result.snapshot;
  }

  function scheduleBackground(readOptions: PublicSnapshotReadOptions): void {
    if (backgroundPending) return;
    backgroundPending = true;
    const work = check({ force: false, kvMissing: false })
      .then((result) => result.write, () => undefined)
      .finally(() => {
        backgroundPending = false;
      });
    readOptions.waitUntil?.(work);
  }

  async function read(readOptions: PublicSnapshotReadOptions = {}): Promise<PublicSnapshot | null> {
    const timing = readOptions.timing ?? newPublicSnapshotTiming();
    let current = memo;
    if (current === undefined || now() - current.loadedAt >= memoTtlMs) {
      const epochBefore = rebuildEpoch;
      const kvStarted = performance.now();
      const loaded = await loadFromKv();
      timing.kvMs = elapsedSince(kvStarted);
      if (loaded.kind === "error") return null;
      if (loaded.kind === "miss") {
        return serveCheck({ force: false, kvMissing: true, epochAtMiss: epochBefore }, readOptions, timing);
      }
      if (memo !== undefined && rebuildEpoch !== epochBefore) {
        // A rebuild finished during the KV read, so its memo is newer than what was just read.
        current = memo;
        timing.source = "memo";
      } else {
        const sameFingerprint = memo !== undefined && memo.snapshot.fingerprint === loaded.snapshot.fingerprint;
        current = {
          snapshot: loaded.snapshot,
          loadedAt: now(),
          verifiedAt: sameFingerprint && memo !== undefined ? memo.verifiedAt : timeOf(loaded.snapshot.built_at),
        };
        memo = current;
        timing.source = "kv";
      }
    } else {
      timing.source = "memo";
    }

    const age = now() - current.verifiedAt;
    // 60 s synchronous path (the accepted staleness bound). A snapshot not verified for 60 s waits here for the
    // fingerprint check, one statement, and rebuilds only when the fingerprint changed. This path is intended.
    if (age > hardStaleAfterMs) return serveCheck({ force: false, kvMissing: false }, readOptions, timing);
    // 30 s background path: the snapshot is still served now, and the fingerprint check runs after the response.
    if (age > staleAfterMs) scheduleBackground(readOptions);
    return current.snapshot;
  }

  async function refresh(): Promise<PublicSnapshot | null> {
    memo = undefined;
    let result: CheckResult;
    try {
      result = await check({ force: true, kvMissing: false });
    } catch {
      return null;
    }
    if (result.write !== undefined) await result.write;
    return result.snapshot;
  }

  return { read, refresh };
}

function timeOf(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseSnapshot(text: string): PublicSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)
    || value.version !== PUBLIC_SNAPSHOT_VERSION
    || typeof value.built_at !== "string"
    || typeof value.fingerprint !== "string"
    || typeof value.content_hash !== "string"
    || !Array.isArray(value.events)
    || !isRecord(value.details)
    || !(value.geojson === null || isRecord(value.geojson))) {
    return null;
  }
  return value as unknown as PublicSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
