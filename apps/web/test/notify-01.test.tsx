import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HistoryEntry, PublicScope, TimeScope } from "@waspada/worker/public-contracts";
import { ApiHttpError, type PublicUpdatePage } from "../src/api-client.js";
import {
  createInterestNotifier,
  notificationContent,
  NOTIFY_EMERGENCY_LINE,
  NOTIFY_MAX_PER_CYCLE,
  NOTIFY_STORAGE_KEY,
  readNotifyEnabled,
  summaryContent,
  writeNotifyEnabled,
  type NotificationContent,
} from "../src/interest-notifications.js";
import { NOTIFY_INTRO, NOTIFY_NOT_EMERGENCY, NOTIFY_TAB_NOTE, NotificationSettings } from "../src/NotificationSettings.js";
import { emptyInterests, type BriefingInterests, type PreferencesStorage } from "../src/preferences-store.js";
import type { UpdateCenterScheduler } from "../src/UpdatesCenter.js";

/** NOTIFY-01: "Area saya" browser notifications, matched on the device, only while a tab is open. */

const at = "2026-11-23T04:05:00.000Z";
const eventTime: TimeScope = { start: "2026-11-23", end: null, precision: "date" };
const emptyScope: PublicScope = { places: [], services: [], institutions: [], audiences: [] };

function detail(eventId: string, overrides: Record<string, unknown> = {}) {
  return {
    event_id: eventId,
    version: 3,
    title: "Genangan fiktif di " + eventId,
    category: "disasters_weather",
    lifecycle: "ongoing",
    freshness: { status: "current", evaluated_at: at, review_due_at: null, basis: "manual_review" },
    event_time: eventTime,
    published_at: at,
    scope: { ...emptyScope, places: ["Cawang"] },
    claims: [],
    impacts: [],
    ...overrides,
  };
}

function change(eventId: string, changeType: HistoryEntry["change_type"] = "published", version = 2): HistoryEntry {
  return { event_id: eventId, version, change_type: changeType, changed_at: at, summary: "Perubahan fiktif." };
}

function page(items: HistoryEntry[], cursor: string): PublicUpdatePage {
  return { items, next_cursor: cursor, cursor_expires_at: "2026-12-23T04:06:00.000Z", checked_at: at };
}

class MemoryStorage implements PreferencesStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const idleScheduler: UpdateCenterScheduler = { setTimeout: () => 0, clearTimeout: () => {} };
const byCategory: BriefingInterests = { ...emptyInterests(), categories: ["disasters_weather"] };

function harness(pages: Array<PublicUpdatePage | Error>, details: Record<string, unknown>, interests = byCategory) {
  const shown: NotificationContent[] = [];
  const cursors: Array<string | undefined> = [];
  const notifier = createInterestNotifier({
    interests,
    notify: (content) => shown.push(content),
    scheduler: idleScheduler,
    getUpdates: async (cursor) => {
      cursors.push(cursor);
      const next = pages.shift();
      if (!next) return page([], cursor ?? "c-idle");
      if (next instanceof Error) throw next;
      return next;
    },
    getDetail: async (eventId) => {
      if (!(eventId in details)) throw new ApiHttpError(404);
      return details[eventId];
    },
  });
  return { notifier, shown, cursors };
}

test("NOTIFY-01: the first cycle is a baseline and notifies nothing, so opening the page never replays old events", async () => {
  const { notifier, shown, cursors } = harness([page([], "c1")], {});
  await notifier.cycle();
  assert.deepEqual(cursors, [undefined]);
  assert.equal(shown.length, 0);
});

test("NOTIFY-01: a matching new event notifies once with its title and the 112 line; a repeat is not notified again", async () => {
  const { notifier, shown, cursors } = harness(
    [page([], "c1"), page([change("evt-a")], "c2"), page([change("evt-a")], "c3")],
    { "evt-a": detail("evt-a") },
  );
  await notifier.cycle();
  await notifier.cycle();
  await notifier.cycle();
  assert.deepEqual(cursors, [undefined, "c1", "c2"]);
  assert.equal(shown.length, 1);
  assert.equal(shown[0]?.title, "Laporan baru di area Anda");
  assert.ok(shown[0]?.body.includes("Genangan fiktif di evt-a"));
  assert.ok(shown[0]?.body.includes(NOTIFY_EMERGENCY_LINE));
  assert.equal(shown[0]?.eventId, "evt-a");
});

test("NOTIFY-01: a correction says diperbarui; retracted changes and events that match no interest are not notified", async () => {
  const { notifier, shown } = harness(
    [page([], "c1"), page([change("evt-b", "corrected"), change("evt-c", "retracted"), change("evt-d")], "c2")],
    {
      "evt-b": detail("evt-b"),
      "evt-c": detail("evt-c"),
      "evt-d": detail("evt-d", { category: "crime_personal_security", scope: emptyScope }),
    },
  );
  await notifier.cycle();
  await notifier.cycle();
  assert.deepEqual(shown.map((item) => [item.title, item.eventId]), [["Laporan diperbarui di area Anda", "evt-b"]]);
});

test("NOTIFY-01: a place interest matches by the event's scope, with no category chosen", async () => {
  const { notifier, shown } = harness(
    [page([], "c1"), page([change("evt-e")], "c2")],
    { "evt-e": detail("evt-e", { category: "crime_personal_security" }) },
    { ...emptyInterests(), places: ["cawang"] },
  );
  await notifier.cycle();
  await notifier.cycle();
  assert.deepEqual(shown.map((item) => item.eventId), ["evt-e"]);
});

test("NOTIFY-01: more matches than the cap give the cap's single notifications and one summary", async () => {
  const ids = ["e1", "e2", "e3", "e4", "e5"];
  const { notifier, shown } = harness(
    [page([], "c1"), page(ids.map((id) => change(id)), "c2")],
    Object.fromEntries(ids.map((id) => [id, detail(id)])),
  );
  await notifier.cycle();
  await notifier.cycle();
  assert.equal(shown.length, NOTIFY_MAX_PER_CYCLE + 1);
  assert.deepEqual(shown.at(-1), summaryContent(ids.length - NOTIFY_MAX_PER_CYCLE));
});

test("NOTIFY-01: an expired cursor (410) starts a new baseline and replays nothing; other failures stay quiet", async () => {
  const { notifier, shown, cursors } = harness(
    [page([], "c1"), new ApiHttpError(410), page([], "c9"), new Error("network")],
    {},
  );
  await notifier.cycle();
  await notifier.cycle();
  await notifier.cycle();
  await notifier.cycle();
  assert.deepEqual(cursors, [undefined, "c1", undefined, "c9"]);
  assert.equal(shown.length, 0);
});

test("NOTIFY-01: notification text never claims an area is safe", () => {
  const texts = [
    notificationContent({ change: change("x"), event: detail("x") as never, relevance: { category: true, scope: false } }),
    summaryContent(4),
  ].flatMap((item) => [item.title, item.body]);
  for (const text of [...texts, NOTIFY_INTRO, NOTIFY_TAB_NOTE, NOTIFY_NOT_EMERGENCY]) {
    assert.doesNotMatch(text, /\baman\b/iu);
  }
});

test("NOTIFY-01: the setting is off by default, stored only as on, and cleared when turned off", () => {
  const storage = new MemoryStorage();
  assert.equal(readNotifyEnabled(storage), false);
  assert.equal(writeNotifyEnabled(storage, true), true);
  assert.equal(storage.values.get(NOTIFY_STORAGE_KEY), "on");
  assert.equal(readNotifyEnabled(storage), true);
  writeNotifyEnabled(storage, false);
  assert.equal(storage.values.has(NOTIFY_STORAGE_KEY), false);
  assert.equal(readNotifyEnabled(null), false);
});

test("NOTIFY-01: the settings card explains each state and only offers to turn on when it can work", () => {
  const storage = new MemoryStorage();
  const render = (props: { permission: "unsupported" | "default" | "granted" | "denied"; live?: boolean; hasInterests?: boolean }) =>
    renderToStaticMarkup(createElement(NotificationSettings, {
      storage,
      live: props.live ?? true,
      hasInterests: props.hasInterests ?? true,
      permission: props.permission,
    }));
  const off = render({ permission: "default" });
  assert.ok(off.includes(NOTIFY_INTRO) && off.includes(NOTIFY_TAB_NOTE) && off.includes(NOTIFY_NOT_EMERGENCY));
  assert.match(off, /<button type="button" class="button button--primary">Aktifkan notifikasi<\/button>/u);
  assert.match(render({ permission: "unsupported" }), /tidak mendukung notifikasi/u);
  assert.match(render({ permission: "default", live: false }), /bukan data contoh/u);
  assert.match(render({ permission: "default", hasInterests: false }), /Simpan minimal satu minat/u);
  assert.match(render({ permission: "denied" }), /diblokir di pengaturan browser/u);
  assert.match(render({ permission: "denied" }), /disabled=""[^>]*>Aktifkan notifikasi/u);
  storage.setItem(NOTIFY_STORAGE_KEY, "on");
  const on = render({ permission: "granted" });
  assert.match(on, /data-status="on"/u);
  assert.match(on, />Matikan notifikasi</u);
});
