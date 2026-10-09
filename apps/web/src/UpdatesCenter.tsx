import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  BriefingInterests,
  Category,
  FreshnessStatus,
  HistoryEntry,
  Lifecycle,
  PublicContext,
  PublicScope,
  TimeScope,
} from "@waspada/worker/public-contracts";
import { ApiHttpError, ApiPayloadError, getEventDetailWithSignal, getPublicUpdates, type PublicUpdatePage } from "./api-client.js";
import { categoryLabel } from "./display.js";
import {
  browserPreferencesStorage,
  loadPreferences,
  normalizeInterests,
  PREFERENCES_STORAGE_KEY,
  type LoadPreferencesResult,
  type PreferencesStorage,
} from "./preferences-store.js";

export const UPDATE_CURSOR_STORAGE_KEY = "waspada-jakarta:updates:cursor:v1";
export const UPDATE_PAGE_SIZE = 20;
export const UPDATE_MAX_PAGES_PER_CYCLE = 5;
export const UPDATE_DETAIL_CONCURRENCY = 4;
export const UPDATE_POLL_INTERVAL_MS = 60_000;

const cursorMaxLength = 2_048;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const categories: readonly Category[] = [
  "crime_personal_security",
  "demonstrations_public_gatherings",
  "crowds_major_events",
  "violence_immediate_threats",
  "disasters_weather",
  "fires_infrastructure_hazards",
  "transport_road_incidents",
  "utilities_essential_services",
  "health_environmental_advisories",
  "group_specific_critical_notices",
];
const lifecycles: readonly Lifecycle[] = ["planned", "ongoing", "resolved", "cancelled", "unknown"];
const freshnessStatuses: readonly FreshnessStatus[] = ["current", "needs_update", "expired"];

export interface CurrentUpdateEvent {
  event_id: string;
  version: number;
  title: string;
  category: Category;
  lifecycle: Lifecycle;
  freshness: { status: FreshnessStatus };
  event_time: TimeScope;
  published_at: string;
  scopes: PublicScope[];
}

export interface MatchedPublicUpdate {
  change: HistoryEntry;
  event: CurrentUpdateEvent;
  relevance: { category: boolean; scope: boolean };
}

export type UpdateCenterState = {
  status: "loading" | "ready" | "retry" | "unavailable";
  phase: "baseline" | "updates" | "details" | "snapshot";
  items: MatchedPublicUpdate[];
  checkedAt: string | null;
  resetNotice: boolean;
  failure: "feed" | "details" | "snapshot" | "storage" | null;
};

export interface UpdateCenterScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface UpdateCenterPollerOptions {
  interests: BriefingInterests;
  storage: PreferencesStorage;
  getUpdates?: (cursor: string | undefined, signal: AbortSignal) => Promise<PublicUpdatePage>;
  getDetail?: (eventId: string, signal: AbortSignal) => Promise<unknown>;
  refreshCurrentEvents: () => Promise<void>;
  onState: (state: UpdateCenterState) => void;
  isSessionCurrent?: () => boolean;
  scheduler?: UpdateCenterScheduler;
}

export interface UpdateCenterPoller {
  start(visible: boolean): void;
  setVisible(visible: boolean): void;
  refresh(): Promise<void>;
  stop(): void;
}

const browserScheduler: UpdateCenterScheduler = {
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const initialPollerState: UpdateCenterState = {
  status: "loading",
  phase: "baseline",
  items: [],
  checkedAt: null,
  resetNotice: false,
  failure: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isMember<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && instantPattern.test(value) && !Number.isNaN(Date.parse(value));
}

function isDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !datePattern.test(value)) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isValidStoredCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= cursorMaxLength;
}

function parseScope(value: unknown): PublicScope {
  const fields = ["places", "services", "institutions", "audiences"] as const;
  if (!isRecord(value) || !hasExactKeys(value, fields)) throw new ApiPayloadError();
  const parsed: PublicScope = { places: [], services: [], institutions: [], audiences: [] };
  for (const field of fields) {
    const names = value[field];
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
      throw new ApiPayloadError();
    }
    parsed[field] = names as string[];
  }
  return parsed;
}

function parseTimeScope(value: unknown): TimeScope {
  if (!isRecord(value) || !hasExactKeys(value, ["start", "end", "precision"])
    || !isMember(value.precision, ["exact", "date", "range", "unknown"] as const)) {
    throw new ApiPayloadError();
  }
  const valid = value.precision === "exact"
    ? isInstant(value.start) && (value.end === null || isInstant(value.end))
    : value.precision === "date"
      ? isDateOnly(value.start) && (value.end === null || isDateOnly(value.end))
      : value.precision === "range"
        ? (isInstant(value.start) || isDateOnly(value.start))
          && (isInstant(value.end) || isDateOnly(value.end))
      : value.start === null && value.end === null;
  if (!valid) throw new ApiPayloadError();
  if (value.end !== null) {
    const start = value.start as string;
    const end = value.end as string;
    if (value.precision === "exact" && Date.parse(end) < Date.parse(start)) throw new ApiPayloadError();
    if (value.precision === "date" && end < start) throw new ApiPayloadError();
    if (value.precision === "range") {
      const startIsDate = isDateOnly(start);
      const endIsDate = isDateOnly(end);
      if (startIsDate && endIsDate && end < start) throw new ApiPayloadError();
      if (!startIsDate && !endIsDate && Date.parse(end) < Date.parse(start)) throw new ApiPayloadError();
    }
  }
  return {
    start: value.start as string | null,
    end: value.end as string | null,
    precision: value.precision,
  };
}

function parseFreshnessStatus(value: unknown): { status: FreshnessStatus } {
  if (!isRecord(value) || !hasExactKeys(value, ["status", "evaluated_at", "review_due_at", "basis"])
    || !isMember(value.status, freshnessStatuses)
    || !isInstant(value.evaluated_at)
    || !(value.review_due_at === null || isInstant(value.review_due_at))
    || !isMember(value.basis, ["source_validity", "fast_observation_review", "undated_advisory_review", "manual_review", "unknown"] as const)) {
    throw new ApiPayloadError();
  }
  return { status: value.status };
}

export function validateCurrentUpdateEvent(value: unknown, expectedEventId: string, updateVersion: number): CurrentUpdateEvent {
  if (!isRecord(value)
    || value.event_id !== expectedEventId
    || !Number.isSafeInteger(value.version) || (value.version as number) < updateVersion
    || typeof value.title !== "string" || value.title.length < 1 || value.title.length > 500
    || !isMember(value.category, categories)
    || !isMember(value.lifecycle, lifecycles)
    || !isInstant(value.published_at)) {
    throw new ApiPayloadError();
  }

  const freshness = parseFreshnessStatus(value.freshness);
  const eventTime = parseTimeScope(value.event_time);
  const scopes: PublicScope[] = [parseScope(value.scope)];
  for (const field of ["claims", "impacts"] as const) {
    const records = value[field];
    if (!Array.isArray(records)) throw new ApiPayloadError();
    for (const record of records) {
      if (!isRecord(record)) throw new ApiPayloadError();
      scopes.push(parseScope(record.scope));
    }
  }

  return {
    event_id: expectedEventId,
    version: value.version as number,
    title: value.title,
    category: value.category,
    lifecycle: value.lifecycle,
    freshness,
    event_time: eventTime,
    published_at: value.published_at,
    scopes,
  };
}

function normalizedIdentity(value: string): string {
  return value.normalize("NFC").trim().toLocaleLowerCase("id-ID");
}

export function matchPublicUpdate(event: CurrentUpdateEvent, interests: BriefingInterests): MatchedPublicUpdate["relevance"] {
  const category = interests.categories.includes(event.category);
  const fieldPairs = [
    ["places", "places"],
    ["services", "services"],
    ["institutions", "institutions"],
    ["audiences", "audiences"],
  ] as const;
  const scope = fieldPairs.some(([interestField, scopeField]) => {
    const selected = new Set(interests[interestField].map(normalizedIdentity));
    return selected.size > 0 && event.scopes.some((eventScope) =>
      eventScope[scopeField].some((name) => selected.has(normalizedIdentity(name))),
    );
  });
  return { category, scope };
}

export async function hydrateAndMatchUpdates(
  changes: readonly HistoryEntry[],
  interests: BriefingInterests,
  getDetail: (eventId: string, signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
): Promise<MatchedPublicUpdate[]> {
  const eventIds = [...new Set(changes.map((change) => change.event_id))];
  const details = new Map<string, CurrentUpdateEvent | null>();
  let nextIndex = 0;
  let failure: unknown;

  const worker = async () => {
    while (failure === undefined && nextIndex < eventIds.length) {
      const eventId = eventIds[nextIndex++];
      if (eventId === undefined) return;
      const relevantChanges = changes.filter((change) => change.event_id === eventId);
      const latestUpdateVersion = Math.max(...relevantChanges.map((change) => change.version));
      try {
        const detail = await getDetail(eventId, signal);
        if (signal.aborted) return;
        details.set(eventId, validateCurrentUpdateEvent(detail, eventId, latestUpdateVersion));
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ApiHttpError && error.status === 404) {
          details.set(eventId, null);
        } else {
          failure = error;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(UPDATE_DETAIL_CONCURRENCY, eventIds.length) }, () => worker()));
  if (signal.aborted) throw new DOMException("The request was aborted", "AbortError");
  if (failure !== undefined) throw failure;

  const matches: MatchedPublicUpdate[] = [];
  for (const change of changes) {
    const event = details.get(change.event_id);
    if (event === null || event === undefined) continue;
    const relevance = matchPublicUpdate(event, interests);
    if (relevance.category || relevance.scope) matches.push({ change, event, relevance });
  }
  return matches;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

class UpdateCenterStorageError extends Error {}

export function createUpdateCenterPoller(options: UpdateCenterPollerOptions): UpdateCenterPoller {
  const scheduler = options.scheduler ?? browserScheduler;
  const readUpdates = options.getUpdates ?? getPublicUpdates;
  const readDetail = options.getDetail ?? ((eventId, signal) => getEventDetailWithSignal(eventId, signal));
  const displayedItems = new Map<string, MatchedPublicUpdate>();
  let state = initialPollerState;
  let active = false;
  let visible = false;
  let cursor: string | null = null;
  let cursorInitialized = false;
  let needsSnapshotRefresh = false;
  let resetNotice = false;
  let generation = 0;
  let timer: unknown;
  let activeController: AbortController | null = null;
  let running: { generation: number; promise: Promise<void> } | null = null;

  const isCurrent = (ticket: number) => active
    && visible
    && generation === ticket
    && (options.isSessionCurrent?.() ?? true);
  const publish = (ticket: number, update: Partial<UpdateCenterState>) => {
    if (!isCurrent(ticket)) return;
    state = { ...state, ...update, items: [...displayedItems.values()] };
    options.onState(state);
  };
  const clearTimer = () => {
    if (timer !== undefined) {
      scheduler.clearTimeout(timer);
      timer = undefined;
    }
  };
  const storeCursor = (nextCursor: string) => {
    try {
      options.storage.setItem(UPDATE_CURSOR_STORAGE_KEY, nextCursor);
    } catch {
      throw new UpdateCenterStorageError();
    }
    cursor = nextCursor;
  };
  const clearCursor = () => {
    // Treat the reset as active in memory before touching browser storage. If
    // removal fails, the current session must still avoid the expired cursor.
    cursor = null;
    cursorInitialized = true;
    try {
      options.storage.removeItem(UPDATE_CURSOR_STORAGE_KEY);
    } catch {
      throw new UpdateCenterStorageError();
    }
  };
  const initializeCursor = () => {
    let stored: string | null;
    try {
      stored = options.storage.getItem(UPDATE_CURSOR_STORAGE_KEY);
    } catch {
      throw new UpdateCenterStorageError();
    }
    cursor = isValidStoredCursor(stored) ? stored : null;
    if (stored !== null && cursor === null) {
      try {
        options.storage.removeItem(UPDATE_CURSOR_STORAGE_KEY);
      } catch {
        throw new UpdateCenterStorageError();
      }
    }
    cursorInitialized = true;
  };
  const scheduleNext = (ticket: number, delayMs = UPDATE_POLL_INTERVAL_MS) => {
    if (!isCurrent(ticket)) return;
    timer = scheduler.setTimeout(() => {
      timer = undefined;
      void runCycle();
    }, delayMs);
  };

  async function performCycle(ticket: number, signal: AbortSignal): Promise<boolean> {
    let pagesRequested = 0;
    let phase: UpdateCenterState["phase"] = "baseline";
    try {
      if (!cursorInitialized) initializeCursor();
      publish(ticket, {
        status: "loading",
        phase: needsSnapshotRefresh ? "snapshot" : cursor === null ? "baseline" : "updates",
        failure: null,
      });

      // A completed baseline is persisted before refreshing the current-event
      // snapshot. If that refresh failed previously, keep it pending and finish
      // it before making any cursor-based update request on this retry.
      if (needsSnapshotRefresh && cursor !== null) {
        phase = "snapshot";
        publish(ticket, { status: "loading", phase, failure: null });
        try {
          await options.refreshCurrentEvents();
        } catch {
          if (!isCurrent(ticket)) return false;
          throw Object.assign(new Error("snapshot"), { updateFailure: "snapshot" as const });
        }
        if (!isCurrent(ticket)) return false;
        needsSnapshotRefresh = false;
        publish(ticket, { status: "ready", phase: "updates", failure: null });
      }

      while (pagesRequested < UPDATE_MAX_PAGES_PER_CYCLE && isCurrent(ticket)) {
        if (cursor === null) {
          phase = "baseline";
          publish(ticket, { status: "loading", phase, failure: null });
          pagesRequested += 1;
          const baseline = await readUpdates(undefined, signal);
          if (!isCurrent(ticket)) return false;
          if (baseline.items.length !== 0) throw new ApiPayloadError();
          storeCursor(baseline.next_cursor);
          publish(ticket, {
            status: needsSnapshotRefresh ? "loading" : "ready",
            phase: needsSnapshotRefresh ? "snapshot" : "updates",
            checkedAt: baseline.checked_at,
            resetNotice,
            failure: null,
          });

          if (needsSnapshotRefresh) {
            phase = "snapshot";
            try {
              await options.refreshCurrentEvents();
            } catch {
              if (!isCurrent(ticket)) return false;
              throw Object.assign(new Error("snapshot"), { updateFailure: "snapshot" as const });
            }
            if (!isCurrent(ticket)) return false;
            needsSnapshotRefresh = false;
            publish(ticket, { status: "ready", phase: "updates", failure: null });
          }
          continue;
        }

        phase = "updates";
        publish(ticket, { status: "loading", phase, failure: null });
        pagesRequested += 1;
        let page: PublicUpdatePage;
        try {
          page = await readUpdates(cursor, signal);
        } catch (error) {
          if (!isCurrent(ticket)) return false;
          if (error instanceof ApiHttpError && error.status === 410) {
            displayedItems.clear();
            needsSnapshotRefresh = true;
            resetNotice = true;
            publish(ticket, {
              status: "loading",
              phase: "baseline",
              items: [],
              checkedAt: null,
              resetNotice: true,
              failure: null,
            });
            clearCursor();
            continue;
          }
          throw error;
        }
        if (!isCurrent(ticket)) return false;

        let pageMatches: MatchedPublicUpdate[] = [];
        if (page.items.length > 0) {
          phase = "details";
          publish(ticket, { status: "loading", phase, failure: null });
          pageMatches = await hydrateAndMatchUpdates(page.items, options.interests, readDetail, signal);
          if (!isCurrent(ticket)) return false;
        }

        storeCursor(page.next_cursor);
        for (const match of pageMatches) {
          const key = match.change.event_id + ":" + match.change.version;
          if (!displayedItems.has(key)) displayedItems.set(key, match);
        }
        publish(ticket, {
          status: "ready",
          phase: "updates",
          checkedAt: page.checked_at,
          resetNotice,
          failure: null,
        });
        if (page.items.length < UPDATE_PAGE_SIZE) break;
      }
      return cursor === null && needsSnapshotRefresh && resetNotice;
    } catch (error) {
      if (!isCurrent(ticket) || isAbortError(error)) return false;
      if (error instanceof UpdateCenterStorageError) {
        publish(ticket, { status: "unavailable", phase, failure: "storage" });
      } else if (phase === "details") {
        publish(ticket, { status: "retry", phase, failure: "details" });
      } else if (phase === "snapshot") {
        publish(ticket, { status: "retry", phase, failure: "snapshot" });
      } else {
        publish(ticket, { status: "unavailable", phase, failure: "feed" });
      }
      return false;
    }
  }

  function runCycle(): Promise<void> {
    if (!active || !visible) return Promise.resolve();
    if (running?.generation === generation) return running.promise;
    clearTimer();
    const ticket = ++generation;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const promise = performCycle(ticket, controller.signal).then((continueRecoveryImmediately) => {
      if (isCurrent(ticket)) {
        activeController = null;
        scheduleNext(ticket, continueRecoveryImmediately ? 0 : UPDATE_POLL_INTERVAL_MS);
      }
    }).finally(() => {
      if (running?.generation === ticket) running = null;
    });
    running = { generation: ticket, promise };
    return promise;
  }

  return {
    start(initiallyVisible) {
      if (active) return;
      active = true;
      visible = initiallyVisible;
      if (visible) void runCycle();
    },
    setVisible(nextVisible) {
      if (!active || visible === nextVisible) return;
      visible = nextVisible;
      if (!visible) {
        generation += 1;
        clearTimer();
        activeController?.abort();
        activeController = null;
        return;
      }
      void runCycle();
    },
    refresh() {
      return runCycle();
    },
    stop() {
      if (!active) return;
      active = false;
      visible = false;
      generation += 1;
      clearTimer();
      activeController?.abort();
      activeController = null;
    },
  };
}

export type PreferencesGate = "unknown" | "demo" | "malformed" | "unavailable" | "empty" | "live";

export function resolvePreferencesGate(context: PublicContext | null, preferences: LoadPreferencesResult): PreferencesGate {
  if (context?.dataset_mode !== "live") return context === null ? "unknown" : "demo";
  if (preferences.status === "malformed") return "malformed";
  if (preferences.status === "unavailable") return "unavailable";
  if (preferences.status === "empty") return "empty";
  const validation = normalizeInterests(preferences.interests);
  if (!validation.ok) return "malformed";
  const { places, services, institutions, audiences, categories: selectedCategories } = validation.interests;
  return places.length + services.length + institutions.length + audiences.length + selectedCategories.length > 0
    ? "live"
    : "empty";
}

function interestsSnapshot(preferences: LoadPreferencesResult): string | null {
  if (preferences.status !== "loaded") return null;
  const validation = normalizeInterests(preferences.interests);
  return validation.ok ? JSON.stringify(validation.interests) : null;
}

function formatJakartaInstant(value: string | null) {
  if (value === null) return "Belum diperiksa";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Waktu pemeriksaan tidak valid";
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
    hourCycle: "h23",
  }).format(date) + " WIB";
}

function formatEventTime(value: TimeScope) {
  if (value.precision === "unknown" || value.start === null) return "Tidak diketahui";
  const dateFormatter = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeZone: "UTC" });
  const formatDateOnly = (date: string) => dateFormatter.format(new Date(date + "T00:00:00.000Z"));
  const formatBound = (bound: string) => isDateOnly(bound) ? formatDateOnly(bound) : formatJakartaInstant(bound);
  const start = formatBound(value.start);
  const end = value.end === null ? null : formatBound(value.end);
  const precision = value.precision === "date" ? "tanggal saja" : value.precision === "range" ? "rentang waktu" : "waktu tepat";
  return (end === null ? start : start + " sampai " + end) + " (" + precision + ")";
}

function changeTypeLabel(value: HistoryEntry["change_type"]) {
  switch (value) {
    case "published": return "Versi dipublikasikan";
    case "corrected": return "Versi dikoreksi";
    case "impact_changed": return "Dampak diperbarui";
    case "retracted": return "Pernyataan terkait ditarik";
  }
}

function UpdateCard({ item }: { item: MatchedPublicUpdate }) {
  const eventId = encodeURIComponent(item.change.event_id);
  const reasons = [
    ...(item.relevance.category ? ["Cocok dengan kategori pilihan Anda."] : []),
    ...(item.relevance.scope ? ["Cocok dengan nama lingkup yang tersimpan di browser ini."] : []),
  ];
  return (
    <article className="update-center-card" aria-labelledby={"update-" + eventId + "-" + item.change.version}>
      <div className="update-center-card__heading">
        <div>
          <p className="section-kicker">{changeTypeLabel(item.change.change_type)} · versi {item.change.version}</p>
          <h3 id={"update-" + eventId + "-" + item.change.version}>{item.event.title}</h3>
        </div>
        <a className="text-link" href={"#detail/api/" + eventId}>Buka detail, bukti, dan riwayat</a>
      </div>
      <p className="update-center-card__summary">{item.change.summary || "Ringkasan perubahan tidak tersedia."}</p>
      <dl className="update-center-card__facts">
        <div><dt>Kategori saat ini</dt><dd>{categoryLabel(item.event.category)}</dd></div>
        <div><dt>Siklus saat ini</dt><dd>{lifecycleLabel(item.event.lifecycle)}</dd></div>
        <div><dt>Kesegaran saat ini</dt><dd>{freshnessLabel(item.event.freshness.status)}</dd></div>
        <div><dt>Waktu kejadian saat ini</dt><dd>{formatEventTime(item.event.event_time)}</dd></div>
        <div><dt>Waktu perubahan dipublikasikan</dt><dd><time dateTime={item.change.changed_at}>{formatJakartaInstant(item.change.changed_at)}</time></dd></div>
      </dl>
      <section className="update-center-card__relevance" aria-label="Alasan kecocokan lokal">
        <strong>Mengapa muncul</strong>
        <ul>{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      </section>
    </article>
  );
}

export function UpdateCenterContent({
  gate,
  state,
  onRefresh,
}: {
  gate: PreferencesGate;
  state: UpdateCenterState;
  onRefresh: () => void;
}) {
  return (
    <main id="main-content" tabIndex={-1} className="main-shell updates-center-page">
      <section className="page-intro" aria-labelledby="updates-center-title">
        <div>
          <p className="section-kicker">Pembaruan untuk minat lokal</p>
          <h1 id="updates-center-title">Pembaruan</h1>
        </div>
        <p className="page-intro__copy">Hanya ringkasan perubahan yang cocok dengan minat tersimpan dan detail event publik terkini yang ditampilkan.</p>
      </section>

      {gate === "unknown" ? (
        <section className="state-panel" role="status"><strong>Status dataset belum dapat diverifikasi.</strong><p>Pembaruan tidak dimuat sampai API mengonfirmasi mode live.</p></section>
      ) : gate === "demo" ? (
        <section className="state-panel" role="status"><strong>Pembaruan live tidak tersedia pada mode demo.</strong><p>Data demo dan fixture tidak digunakan untuk mencocokkan minat Anda.</p></section>
      ) : gate === "malformed" ? (
        <section className="state-panel" role="alert"><strong>Minat tersimpan tidak dapat dibaca.</strong><p>Periksa atau hapus data minat secara eksplisit sebelum memakai pusat pembaruan.</p><a className="text-link" href="#ringkasan-saya">Periksa minat tersimpan</a></section>
      ) : gate === "unavailable" ? (
        <section className="state-panel" role="status"><strong>Penyimpanan browser tidak dapat dibaca.</strong><p>Pembaruan tidak dimuat. Aktifkan penyimpanan lokal atau periksa pengaturan browser.</p></section>
      ) : gate === "empty" ? (
        <section className="state-panel" role="status"><strong>Tambahkan minat sebelum memuat pembaruan.</strong><p>Pilih tempat, layanan, institusi, kelompok, atau kategori yang ingin Anda ikuti.</p><a className="text-link" href="#ringkasan-saya">Atur minat di perangkat ini</a></section>
      ) : (
        <>
          <section className="updates-center-privacy" aria-label="Privasi minat">
            <strong>Minat tetap di browser ini.</strong>
            <p>Permintaan pembaruan tidak mengirim pilihan minat. Kecocokan dihitung di perangkat dari kategori dan nama lingkup pada detail publik yang dimuat.</p>
            <p>Mode live tidak memastikan sumber tertentu tersambung atau seluruh cakupan tersedia.</p>
          </section>

          {state.resetNotice && (
            <p className="updates-center-reset" role="status">Penanda pembaruan diperbarui. Ringkasan sebelumnya tidak lagi tersedia.</p>
          )}
          {state.status === "loading" && (
            <div className="state-panel state-panel--loading" role="status" aria-live="polite" aria-busy="true">
              <strong>{state.phase === "baseline" ? "Menetapkan titik awal pembaruan…" : state.phase === "snapshot" ? "Memperbarui halaman event publik…" : state.phase === "details" ? "Memeriksa detail event publik…" : "Memuat pembaruan live…"}</strong>
            </div>
          )}
          {state.status === "unavailable" && (
            <div className="state-panel state-panel--error" role="alert">
              <strong>{state.failure === "storage" ? "Penanda pembaruan tidak dapat disimpan." : "Pembaruan belum dapat dimuat."}</strong>
              <p>{state.failure === "storage" ? "Periksa izin penyimpanan browser. Tidak ada minat atau isi pembaruan yang disimpan." : "Coba lagi saat koneksi API tersedia. Keadaan keselamatan tidak diketahui."}</p>
              <button className="button button--quiet" type="button" onClick={onRefresh}>Coba lagi</button>
            </div>
          )}
          {state.status === "retry" && (
            <div className="state-panel state-panel--error" role="alert">
              <strong>{state.failure === "details" ? "Sebagian detail laporan belum dapat diperiksa." : "Daftar laporan terbaru belum dapat dimuat."}</strong>
              <p>Pembaruan baru belum dapat diterapkan. Coba lagi; pembaruan yang sudah ditampilkan tetap tersedia.</p>
              <button className="button button--quiet" type="button" onClick={onRefresh}>Coba lagi memuat halaman</button>
            </div>
          )}
          {state.status === "ready" && state.items.length === 0 && (
            <section className="updates-center-empty" aria-live="polite">
              <p role="status">Belum ada pembaruan yang cocok dengan minat tersimpan.</p>
              <p>Hasil kosong bukan pernyataan bahwa area aman.</p>
              <button className="button button--quiet" type="button" onClick={onRefresh}>Periksa pembaruan sekarang</button>
            </section>
          )}
          {state.status === "ready" && state.items.length > 0 && (
            <section className="updates-center-results" aria-labelledby="updates-results-title">
              <div className="updates-center-results__heading">
                <h2 id="updates-results-title">{state.items.length} pembaruan cocok</h2>
                <button className="button button--quiet" type="button" onClick={onRefresh}>Periksa pembaruan sekarang</button>
              </div>
              <ol className="updates-center-list" aria-label="Pembaruan publik yang cocok">
                {state.items.map((item) => <li key={item.change.event_id + ":" + item.change.version}><UpdateCard item={item} /></li>)}
              </ol>
            </section>
          )}
          <p className="updates-center-check" aria-live="polite">Pemeriksaan sistem terakhir: <time dateTime={state.checkedAt ?? undefined}>{formatJakartaInstant(state.checkedAt)}</time>.</p>
        </>
      )}
    </main>
  );
}

function lifecycleLabel(value: Lifecycle) {
  switch (value) {
    case "planned": return "Direncanakan";
    case "ongoing": return "Berlangsung";
    case "resolved": return "Selesai";
    case "cancelled": return "Dibatalkan";
    case "unknown": return "Belum diketahui";
  }
}

function freshnessLabel(value: FreshnessStatus) {
  switch (value) {
    case "current": return "Dalam batas tinjau saat evaluasi";
    case "needs_update": return "Perlu diperbarui";
    case "expired": return "Masa berlaku sumber berakhir";
  }
}

export interface UpdatesCenterProps {
  context: PublicContext | null;
  storage?: PreferencesStorage | null;
  refreshCurrentEvents: () => Promise<void>;
}

export function UpdatesCenter({ context, storage, refreshCurrentEvents }: UpdatesCenterProps) {
  const [activeStorage] = useState<PreferencesStorage | null>(() =>
    storage === undefined ? browserPreferencesStorage() : storage,
  );
  const [preferences, setPreferences] = useState<LoadPreferencesResult>(() => loadPreferences(activeStorage));
  const [state, setState] = useState<UpdateCenterState>(initialPollerState);
  const pollerRef = useRef<UpdateCenterPoller | null>(null);
  const gate = resolvePreferencesGate(context, preferences);
  const interestKey = interestsSnapshot(preferences);
  const sessionKey = gate === "live" && interestKey !== null ? JSON.stringify([context, interestKey]) : null;
  const activeSessionKeyRef = useRef<string | null>(sessionKey);

  useIsoLayoutEffect(() => {
    activeSessionKeyRef.current = sessionKey;
  }, [sessionKey]);

  useEffect(() => {
    const reload = () => setPreferences(loadPreferences(activeStorage));
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === PREFERENCES_STORAGE_KEY) {
        pollerRef.current?.stop();
        pollerRef.current = null;
        reload();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [activeStorage]);

  useIsoLayoutEffect(() => {
    if (gate !== "live" || interestKey === null || activeStorage === null) {
      setState(initialPollerState);
      pollerRef.current = null;
      return;
    }

    const validation = normalizeInterests(preferences.status === "loaded" ? preferences.interests : null);
    if (!validation.ok) return;
    const poller = createUpdateCenterPoller({
      interests: validation.interests,
      storage: activeStorage,
      refreshCurrentEvents,
      onState: setState,
      isSessionCurrent: () => activeSessionKeyRef.current === sessionKey,
    });
    pollerRef.current = poller;
    poller.start(document.visibilityState === "visible");
    const onVisibility = () => poller.setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      poller.stop();
      if (pollerRef.current === poller) pollerRef.current = null;
    };
  }, [activeStorage, context, gate, interestKey, preferences, refreshCurrentEvents, sessionKey]);

  return <UpdateCenterContent gate={gate} state={state} onRefresh={() => { void pollerRef.current?.refresh(); }} />;
}
