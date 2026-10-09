import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  BriefingResponse,
  EventView,
  HistoryEntry,
  PublicContext,
} from "@waspada/worker/public-contracts";
import { BriefingResultsView } from "../src/BriefingResults.js";
import { EventDetail } from "../src/EventDetail.js";
import { EventFeed } from "../src/EventFeed.js";
import { ModeratorReview } from "../src/ModeratorReview.js";
import { Preferences } from "../src/Preferences.js";
import {
  UpdateCenterContent,
  type MatchedPublicUpdate,
  type UpdateCenterState,
} from "../src/UpdatesCenter.js";
import { emptyInterests } from "../src/preferences-store.js";

const evaluatedAt = "2026-10-01T00:00:00.000Z";
const liveContext: PublicContext = {
  dataset_mode: "live",
  dataset_label: "live",
  generated_at: evaluatedAt,
  sources: [],
};

const expiredEvent: EventView = {
  event_id: "public-expired-status",
  version: 4,
  title: "Laporan untuk uji status sumber",
  summary: "Contoh copy status tanpa data insiden nyata.",
  category: "disasters_weather",
  tags: [],
  lifecycle: "ongoing",
  freshness: {
    status: "expired",
    evaluated_at: evaluatedAt,
    review_due_at: null,
    basis: "source_validity",
  },
  event_time: { start: null, end: null, precision: "unknown" },
  validity: { valid_from: null, valid_until: null },
  scope: { places: [], services: [], institutions: [], audiences: [] },
  claims: [],
  impacts: [],
  published_at: evaluatedAt,
};

const briefing: BriefingResponse = {
  generated_at: evaluatedAt,
  items: [{ event: expiredEvent, relevance_reasons: ["Cocok dengan kategori pilihan Anda."] }],
};

const updateChange: HistoryEntry = {
  event_id: expiredEvent.event_id,
  version: expiredEvent.version,
  change_type: "corrected",
  changed_at: evaluatedAt,
  summary: "Perubahan contoh untuk memeriksa label status.",
};

const matchedUpdate: MatchedPublicUpdate = {
  change: updateChange,
  event: {
    event_id: expiredEvent.event_id,
    version: expiredEvent.version,
    title: expiredEvent.title,
    category: expiredEvent.category,
    lifecycle: expiredEvent.lifecycle,
    freshness: { status: "expired" },
    event_time: expiredEvent.event_time,
    published_at: expiredEvent.published_at,
    scopes: [],
  },
  relevance: { category: true, scope: false },
};

function renderUpdate(state: UpdateCenterState) {
  return renderToStaticMarkup(
    <UpdateCenterContent gate="live" state={state} onRefresh={() => {}} />,
  );
}

test("briefing and updates distinguish review freshness from issuer validity", () => {
  const briefingMarkup = renderToStaticMarkup(
    <BriefingResultsView
      context={liveContext}
      interests={{ ...emptyInterests(), categories: ["disasters_weather"] }}
      state={{ status: "loaded", data: briefing }}
      onRequest={() => {}}
    />,
  );
  const updateMarkup = renderUpdate({
    status: "ready",
    phase: "updates",
    items: [matchedUpdate],
    checkedAt: evaluatedAt,
    resetNotice: false,
    failure: null,
  });

  for (const markup of [briefingMarkup, updateMarkup]) {
    assert.match(markup, /Masa berlaku sumber berakhir/u);
    assert.doesNotMatch(markup, /Batas tinjau lewat/u);
  }
});

test("update recovery copy describes the user-visible effect without cursor jargon", () => {
  const retryMarkup = renderUpdate({
    status: "retry",
    phase: "details",
    items: [],
    checkedAt: evaluatedAt,
    resetNotice: false,
    failure: "details",
  });
  const storageMarkup = renderUpdate({
    status: "unavailable",
    phase: "updates",
    items: [],
    checkedAt: evaluatedAt,
    resetNotice: false,
    failure: "storage",
  });

  assert.match(retryMarkup, /Pembaruan baru belum dapat diterapkan/u);
  assert.match(retryMarkup, /detail laporan belum dapat diperiksa/u);
  assert.match(storageMarkup, /Penanda pembaruan tidak dapat disimpan/u);
  assert.doesNotMatch(retryMarkup + storageMarkup, /cursor|snapshot/iu);
});

test("screen main targets are programmatically focusable for the shared skip link", () => {
  const feed = renderToStaticMarkup(
    <EventFeed
      status="loading"
      events={[]}
      context={null}
      query=""
      onQueryChange={() => {}}
      onRetry={() => {}}
      mapSelection={{ kind: "none" }}
      onSelectApiEvent={() => {}}
      onSelectPresentation={() => {}}
      mobilePanel="list"
      onMobilePanelChange={() => {}}
    />,
  );
  const detail = renderToStaticMarkup(<EventDetail mode="presentation" context={null} />);
  const preferences = renderToStaticMarkup(<Preferences storage={null} context={null} />);
  const review = renderToStaticMarkup(<ModeratorReview />);
  const updates = renderUpdate({
    status: "unavailable",
    phase: "updates",
    items: [],
    checkedAt: null,
    resetNotice: false,
    failure: "feed",
  });

  for (const markup of [feed, detail, preferences, review, updates]) {
    assert.match(markup, /<main id="main-content" tabindex="-1"/u);
  }
});
