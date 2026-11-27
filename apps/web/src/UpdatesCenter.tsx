import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  BriefingInterests,
  FreshnessStatus,
  HistoryEntry,
  Lifecycle,
  PublicContext,
} from "@waspada/worker/public-contracts";
import { ApiHttpError, ApiPayloadError, getEventDetailWithSignal, getPublicUpdates, type PublicUpdatePage } from "./api-client.js";
import { categoryLabel, eventTimeText } from "./display.js";
import { PageHeader } from "./ui/PageHeader.js";
import {
  browserPreferencesStorage,
  loadPreferences,
  normalizeInterests,
  PREFERENCES_STORAGE_KEY,
  type LoadPreferencesResult,
  type PreferencesStorage,
} from "./preferences-store.js";
import {
  hydrateAndMatchUpdates,
  isValidStoredCursor,
  UPDATE_CURSOR_STORAGE_KEY,
  UPDATE_MAX_PAGES_PER_CYCLE,
  UPDATE_PAGE_SIZE,
  UPDATE_POLL_INTERVAL_MS,
  type MatchedPublicUpdate,
} from "./update-matching.js";

export {
  hydrateAndMatchUpdates,
  matchPublicUpdate,
  UPDATE_CURSOR_STORAGE_KEY,
  UPDATE_DETAIL_CONCURRENCY,
  UPDATE_MAX_PAGES_PER_CYCLE,
  UPDATE_PAGE_SIZE,
  UPDATE_POLL_INTERVAL_MS,
  validateCurrentUpdateEvent,
  type CurrentUpdateEvent,
  type MatchedPublicUpdate,
} from "./update-matching.js";

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

function changeTypeLabel(entry: HistoryEntry) {
  // POLISH-02: an automatic refresh is written as "corrected" by the auto-publisher. It is not a moderator correction.
  if (entry.automatic === true) return "Diperbarui otomatis";
  switch (entry.change_type) {
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
          <p className="section-kicker">{changeTypeLabel(item.change)} · versi {item.change.version}</p>
          <h3 id={"update-" + eventId + "-" + item.change.version}>{item.event.title}</h3>
        </div>
        <a className="text-link" href={"#detail/api/" + eventId}>Buka detail, bukti, dan riwayat</a>
      </div>
      <p className="update-center-card__summary">{item.change.summary || "Ringkasan perubahan tidak tersedia."}</p>
      <dl className="update-center-card__facts">
        <div><dt>Kategori saat ini</dt><dd>{categoryLabel(item.event.category)}</dd></div>
        <div><dt>Siklus saat ini</dt><dd>{lifecycleLabel(item.event.lifecycle)}</dd></div>
        <div><dt>Kesegaran saat ini</dt><dd>{freshnessLabel(item.event.freshness.status)}</dd></div>
        <div><dt>Waktu kejadian saat ini</dt><dd>{eventTimeText(item.event.event_time)}</dd></div>
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
    <main id="main-content" className="main-shell updates-center-page">
      <div className="page-column">
        <PageHeader
          eyebrow="Pembaruan untuk minat lokal"
          title="Pembaruan"
          titleId="updates-center-title"
          lead="Perubahan pada laporan terbit yang cocok dengan minat Anda."
        />

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
              <p className="updates-center-reset" role="status">Cursor diperbarui. Ringkasan pembaruan yang lebih lama tidak lagi tersedia setelah penetapan ulang.</p>
            )}
            {state.status === "loading" && (
              <div className="state-panel state-panel--loading" role="status" aria-live="polite" aria-busy="true">
                <strong>{state.phase === "baseline" ? "Menetapkan titik awal pembaruan…" : state.phase === "snapshot" ? "Memperbarui halaman kejadian publik…" : state.phase === "details" ? "Memeriksa detail kejadian publik…" : "Memuat pembaruan langsung…"}</strong>
                <div className="skeleton-stack" aria-hidden="true">
                  <span className="skeleton" />
                  <span className="skeleton skeleton--short" />
                </div>
              </div>
            )}
            {state.status === "unavailable" && (
              <div className="state-panel state-panel--error" role="alert">
                <strong>{state.failure === "storage" ? "Cursor pembaruan tidak dapat disimpan." : "Pembaruan belum dapat dimuat."}</strong>
                <p>{state.failure === "storage" ? "Periksa izin penyimpanan browser. Tidak ada minat atau isi pembaruan yang disimpan." : "Coba lagi saat koneksi API tersedia. Keadaan keselamatan tidak diketahui."}</p>
                <button className="button button--primary" type="button" onClick={onRefresh}>Coba lagi</button>
              </div>
            )}
            {state.status === "retry" && (
              <div className="state-panel state-panel--error" role="alert">
                <strong>{state.failure === "details" ? "Sebagian detail event belum dapat diperiksa." : "Snapshot event belum dapat diperbarui."}</strong>
                <p>Halaman pembaruan belum diterapkan dan cursor tetap di posisi sebelumnya. Coba lagi tanpa kehilangan halaman ini.</p>
                <button className="button button--primary" type="button" onClick={onRefresh}>Coba lagi memuat halaman</button>
              </div>
            )}
            {state.status === "ready" && state.items.length === 0 && (
              <section className="updates-center-empty" aria-live="polite">
                <p role="status">Belum ada pembaruan yang cocok dengan minat tersimpan.</p>
                <p>Hasil kosong bukan pernyataan bahwa area aman.</p>
                <button className="button button--primary" type="button" onClick={onRefresh}>Periksa pembaruan sekarang</button>
              </section>
            )}
            {state.status === "ready" && state.items.length > 0 && (
              <section className="updates-center-results" aria-labelledby="updates-results-title">
                <div className="updates-center-results__heading">
                  <h2 id="updates-results-title">{state.items.length} pembaruan cocok</h2>
                  <button className="button button--primary" type="button" onClick={onRefresh}>Periksa pembaruan sekarang</button>
                </div>
                <ol className="updates-center-list" aria-label="Pembaruan publik yang cocok">
                  {state.items.map((item) => <li key={item.change.event_id + ":" + item.change.version}><UpdateCard item={item} /></li>)}
                </ol>
              </section>
            )}
            <p className="updates-center-check" aria-live="polite">Pemeriksaan sistem terakhir: <time dateTime={state.checkedAt ?? undefined}>{formatJakartaInstant(state.checkedAt)}</time>.</p>
          </>
        )}
      </div>
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
    case "current": return "Dalam batas tinjau";
    case "needs_update": return "Perlu diperbarui";
    case "expired": return "Lewat masa berlaku sumber";
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
