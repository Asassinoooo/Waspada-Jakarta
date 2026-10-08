import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { HistoryPage } from "@waspada/worker/public-contracts";
import { SiteHeader } from "../src/App.js";
import { EventDetail } from "../src/EventDetail.js";
import { EventFeed } from "../src/EventFeed.js";
import { getEventDetail, getEventHistory, getPublicContext, listEvents } from "../src/api-client.js";
import { formatEventTime } from "../src/display.js";

const baseUrl = "http://127.0.0.1:5173";

async function withViteApiBase<T>(read: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  const boundFetch = originalFetch.bind(globalThis);
  globalThis.fetch = ((input, init) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return boundFetch(new URL(path, baseUrl), init);
  }) as typeof fetch;

  try {
    return await read();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function historyLabel(changeType: HistoryPage["data"][number]["change_type"]): string {
  const labels: Record<HistoryPage["data"][number]["change_type"], string> = {
    published: "Versi dipublikasikan",
    corrected: "Versi dikoreksi",
    impact_changed: "Dampak diperbarui",
    retracted: "Versi ditarik",
  };
  return labels[changeType];
}

async function runSmoke() {
  const uiResponse = await fetch(baseUrl);
  assert.equal(uiResponse.status, 200, "Vite should serve the local React shell");
  const shell = await uiResponse.text();
  assert.match(shell, /Waspada Jakarta/);
  assert.match(shell, /theme-color/);

  const { context, page, detail, history } = await withViteApiBase(async () => {
    const context = await getPublicContext();
    const page = await listEvents();
    const listedEvent = page.data[0];
    assert.ok(listedEvent, "the local synthetic event route should return a listed event");

    const [detail, history] = await Promise.all([
      getEventDetail(listedEvent.event_id),
      getEventHistory(listedEvent.event_id),
    ]);
    return { context, page, detail, history };
  });

  assert.equal(context.dataset_mode, "demo");
  assert.equal(context.dataset_label, "synthetic");
  assert.deepEqual(context.sources, []);
  assert.equal(page.data.length, 2);
  const listedEvent = page.data[0];
  assert.ok(listedEvent);
  assert.equal(detail.event_id, listedEvent.event_id, "detail identity should match the listed event requested through the proxy");
  assert.equal(detail.version, listedEvent.version);
  assert.deepEqual(detail.event_time, listedEvent.event_time, "detail should preserve the listed event's API event time");
  const historyEntry = history.data[0];
  assert.ok(historyEntry, "the local synthetic history route should return its fixture entry");
  assert.equal(historyEntry.event_id, detail.event_id);
  assert.equal(historyEntry.version, detail.version);

  const headerMarkup = renderToStaticMarkup(<SiteHeader route={{ screen: "discover" }} context={context} />);
  const feedMarkup = renderToStaticMarkup(
    <EventFeed
      status="loaded"
      events={page.data}
      context={context}
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
  const detailMarkup = renderToStaticMarkup(
    <EventDetail
      mode="api-event"
      apiDetail={{ eventId: detail.event_id, status: "loaded", data: detail }}
      apiHistory={{ eventId: detail.event_id, status: "loaded", data: history }}
      context={context}
    />,
  );

  assert.match(headerMarkup, /DEMO — data sintetis; bukan peringatan langsung/);
  assert.match(feedMarkup, /Tidak ada sumber live yang tersambung/);
  assert.match(feedMarkup, /Contoh fiktif/);
  assert.match(feedMarkup, /Daftar/);
  assert.match(feedMarkup, /Peta/);
  assert.match(feedMarkup, /Status peta koordinat belum tersedia/);
  assert.match(feedMarkup, /tidak memastikan kondisi aman/);
  assert.ok(detailMarkup.includes(detail.title), "detail UI should render the API-provided title");
  assert.ok(detailMarkup.includes(detail.summary), "detail UI should render the API-provided summary");
  assert.ok(detailMarkup.includes(`${historyLabel(historyEntry.change_type)} · versi ${historyEntry.version} · fixture demo`));
  assert.ok(detailMarkup.includes(historyEntry.summary), "detail UI should render the API-provided history summary");
  assert.ok(detailMarkup.includes(formatEventTime(detail)), "detail UI should render event time from the API detail response");
  assert.ok(detailMarkup.includes(`dateTime="${detail.published_at}"`), "detail UI should preserve the API publication timestamp");
  assert.ok(detailMarkup.includes(`dateTime="${historyEntry.changed_at}"`), "history UI should preserve the API change timestamp");
  assert.match(detailMarkup, /Bukti tidak tersedia pada fixture demo ini/);
  assert.match(detailMarkup, /Tidak dipetakan\. Record API ini tidak menyertakan geometri/);
  assert.match(detailMarkup, /Tidak adanya geometri bukan pernyataan bahwa suatu area aman/);
  assert.doesNotMatch(detailMarkup, /fixture presentasi|Jalan Contoh|Sumber dan isi di bawah hanya berada dalam fixture sintetik/);

  console.log("UI/API smoke passed: local shell, context/list/detail/history routes, demo labels, returned timestamps, and honest empty evidence/geometry states.");
}

await runSmoke();
