import assert from "node:assert/strict";
import test from "node:test";
import type { PublicUpdatePage } from "../src/api-client.js";
import { requestBriefingIfEligible } from "../src/BriefingResults.js";
import {
  createUpdateCenterPoller,
  matchPublicUpdate,
  resolvePreferencesGate,
  UPDATE_CURSOR_STORAGE_KEY,
  validateCurrentUpdateEvent,
  type UpdateCenterScheduler,
  type UpdateCenterState,
} from "../src/UpdatesCenter.js";
import {
  emptyInterests,
  loadPreferences,
  PREFERENCES_STORAGE_KEY,
  savePreferences,
  type BriefingInterests,
  type PreferencesStorage,
} from "../src/preferences-store.js";
import type { BriefingResponse, HistoryEntry, PublicContext, PublicScope } from "@waspada/worker/public-contracts";

/**
 * FR-11, client side. Preferences are browser-local, so removing an interest must remove it from the
 * saved store, from the next briefing request and from the update matches a poller produces.
 * Authored fictional places only; no network or model calls.
 */

const checkedAt = "2026-11-12T04:06:00.000Z";
const changedAt = "2026-11-12T04:05:00.000Z";
const liveContext: PublicContext = { dataset_mode: "live", dataset_label: "live", generated_at: checkedAt, sources: [] };

class MemoryStorage implements PreferencesStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

class FakeScheduler implements UpdateCenterScheduler {
  private nextId = 0;
  readonly jobs = new Map<number, () => void>();
  setTimeout(callback: () => void) {
    const id = ++this.nextId;
    this.jobs.set(id, callback);
    return id;
  }
  clearTimeout(handle: unknown) {
    if (typeof handle === "number") this.jobs.delete(handle);
  }
}

function interests(overrides: Partial<BriefingInterests> = {}): BriefingInterests {
  return { ...emptyInterests(), ...overrides };
}

/** The saved interests, or a thrown error that names the non-loaded state. */
function loaded(storage: MemoryStorage): BriefingInterests {
  const result = loadPreferences(storage);
  if (result.status !== "loaded") throw new Error(`preferences are ${result.status}`);
  return result.interests;
}

function placeScope(places: string[]): PublicScope {
  return { places, services: [], institutions: [], audiences: [] };
}

/** A current event detail whose only scope names are the given places, on its claim. */
function detailFor(eventId: string, places: string[]) {
  return {
    event_id: eventId,
    version: 2,
    title: "Genangan fiktif di Cawang",
    category: "disasters_weather",
    lifecycle: "ongoing",
    freshness: { status: "current", evaluated_at: changedAt, review_due_at: null, basis: "manual_review" },
    event_time: { start: "2026-11-11", end: null, precision: "date" },
    published_at: checkedAt,
    scope: placeScope([]),
    claims: [{ scope: placeScope(places) }],
    impacts: [],
  };
}

function change(eventId: string): HistoryEntry {
  return { event_id: eventId, version: 2, change_type: "corrected", changed_at: changedAt, summary: "Perubahan fiktif." };
}

function page(items: HistoryEntry[], cursor: string): PublicUpdatePage {
  return { items, next_cursor: cursor, cursor_expires_at: "2026-12-12T04:06:00.000Z", checked_at: checkedAt };
}

/** Runs one real poller cycle over a stored cursor, with the same change offered by the feed. */
async function pollOnce(
  storage: MemoryStorage,
  pollerInterests: BriefingInterests,
  feed: (cursor: string | undefined) => PublicUpdatePage,
): Promise<UpdateCenterState> {
  const scheduler = new FakeScheduler();
  const states: UpdateCenterState[] = [];
  const poller = createUpdateCenterPoller({
    interests: pollerInterests,
    storage,
    scheduler,
    onState: (state) => states.push(state),
    refreshCurrentEvents: async () => {},
    getUpdates: async (cursor) => feed(cursor),
    getDetail: async (eventId) => detailFor(eventId, ["Cawang"]),
  });
  try {
    poller.start(true);
    await poller.refresh();
  } finally {
    poller.stop();
  }
  const last = states.at(-1);
  assert.ok(last, "the poller reports a state");
  return last;
}

test("removing an interest removes it from the saved store, the next briefing request and the update matches", async () => {
  const storage = new MemoryStorage();
  // No category is saved here, so only the place interest can explain a match.
  const both = interests({ places: ["Cawang", "Kemang"] });
  assert.equal(savePreferences(storage, both).status, "saved");

  const sent: BriefingInterests[] = [];
  const send = async (value: BriefingInterests): Promise<BriefingResponse> => {
    sent.push(value);
    return { items: [], generated_at: checkedAt };
  };

  const savedInterests = loaded(storage);
  assert.notEqual(await requestBriefingIfEligible(liveContext, savedInterests, send), null, "a live request is sent");
  assert.deepEqual(sent.at(-1)?.places, ["Cawang", "Kemang"], "before removal the request names Cawang");

  // The editor drops Cawang and saves; the browser store is the only copy of the interest.
  assert.equal(savePreferences(storage, { ...savedInterests, places: ["Kemang"] }).status, "saved");
  const afterRemoval = loaded(storage);
  assert.deepEqual(afterRemoval.places, ["Kemang"]);
  await requestBriefingIfEligible(liveContext, afterRemoval, send);
  assert.deepEqual(sent.at(-1)?.places, ["Kemang"], "after removal no briefing request names Cawang");

  const current = validateCurrentUpdateEvent(detailFor("event-cawang", ["Cawang"]), "event-cawang", 2);
  assert.equal(matchPublicUpdate(current, savedInterests).scope, true, "Cawang matched before removal");
  assert.equal(matchPublicUpdate(current, afterRemoval).scope, false, "Cawang no longer matches");

  // The same change is offered again from a reset cursor; only the remaining interest may match it.
  storage.values.set(UPDATE_CURSOR_STORAGE_KEY, "cursor-0");
  const feed = (cursor: string | undefined) => page([change("event-cawang")], cursor === undefined ? "cursor-0" : "cursor-1");
  const beforeRemoval = await pollOnce(storage, savedInterests, feed);
  assert.equal(beforeRemoval.items.length, 1);
  assert.deepEqual(beforeRemoval.items[0]?.relevance, { category: false, scope: true }, "the card names the scope it matched");

  storage.values.set(UPDATE_CURSOR_STORAGE_KEY, "cursor-0");
  const afterRemovalState = await pollOnce(storage, afterRemoval, feed);
  assert.equal(afterRemovalState.items.length, 0, "no update card is personalised by the removed interest");
});

test("removing every interest closes the personalised gate, so no briefing request and no update poller start", async () => {
  const storage = new MemoryStorage();
  assert.equal(savePreferences(storage, interests({ places: ["Cawang"] })).status, "saved");
  assert.equal(resolvePreferencesGate(liveContext, loadPreferences(storage)), "live");

  assert.equal(savePreferences(storage, emptyInterests()).status, "saved");
  const cleared = loadPreferences(storage);
  assert.equal(resolvePreferencesGate(liveContext, cleared), "empty");

  let sends = 0;
  const send = async (): Promise<BriefingResponse> => {
    sends += 1;
    return { items: [], generated_at: checkedAt };
  };
  const remaining = cleared.status === "loaded" ? cleared.interests : emptyInterests();
  assert.equal(requestBriefingIfEligible(liveContext, remaining, send), null, "no interest means no briefing request");
  assert.equal(sends, 0);
  // Control: the same live context sends a request as soon as one interest is saved again.
  assert.notEqual(requestBriefingIfEligible(liveContext, interests({ places: ["Kemang"] }), send), null);
  assert.equal(sends, 1);
  assert.equal(storage.values.get(PREFERENCES_STORAGE_KEY)?.includes("Cawang"), false, "the removed name is not left in storage");
});

test("the same change delivered in two cycles is shown once", async () => {
  const storage = new MemoryStorage();
  storage.values.set(UPDATE_CURSOR_STORAGE_KEY, "cursor-0");
  const scheduler = new FakeScheduler();
  const states: UpdateCenterState[] = [];
  let requests = 0;
  const poller = createUpdateCenterPoller({
    interests: interests({ places: ["Cawang"] }),
    storage,
    scheduler,
    onState: (state) => states.push(state),
    refreshCurrentEvents: async () => {},
    getUpdates: async (cursor) => {
      requests += 1;
      return page([change("event-cawang")], cursor === "cursor-1" ? "cursor-2" : "cursor-1");
    },
    getDetail: async (eventId) => detailFor(eventId, ["Cawang"]),
  });
  try {
    poller.start(true);
    await poller.refresh();
    await poller.refresh();
  } finally {
    poller.stop();
  }
  assert.equal(requests, 2, "both cycles read the feed");
  assert.equal(states.at(-1)?.items.length, 1, "one event version is one card, however often it is delivered");
  assert.equal(states.at(-1)?.items[0]?.change.event_id, "event-cawang");
});
