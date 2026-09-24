import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventPage, PublicContext } from "@waspada/worker/public-contracts";
import { SiteHeader } from "../src/App.js";
import { EventFeed } from "../src/EventFeed.js";

const baseUrl = "http://127.0.0.1:5173";

async function runSmoke() {
  const uiResponse = await fetch(baseUrl);
  assert.equal(uiResponse.status, 200, "Vite should serve the local React shell");
  const shell = await uiResponse.text();
  assert.match(shell, /Waspada Jakarta/);
  assert.match(shell, /theme-color/);

  const contextResponse = await fetch(baseUrl + "/api/v1/context");
  assert.equal(contextResponse.status, 200, "the Vite proxy should reach the Worker context route");
  const context = (await contextResponse.json()) as PublicContext;
  assert.equal(context.dataset_mode, "demo");
  assert.equal(context.dataset_label, "synthetic");
  assert.deepEqual(context.sources, []);

  const eventsResponse = await fetch(baseUrl + "/api/v1/events");
  assert.equal(eventsResponse.status, 200, "the Vite proxy should reach the Worker event-list route");
  const page = (await eventsResponse.json()) as EventPage;
  assert.equal(page.data.length, 2);

  const headerMarkup = renderToStaticMarkup(<SiteHeader route={{ screen: "discover" }} />);
  const feedMarkup = renderToStaticMarkup(
    <EventFeed
      status="loaded"
      events={page.data}
      context={context}
      query=""
      onQueryChange={() => {}}
      onRetry={() => {}}
      mapSelection={{ kind: "presentation" }}
      onSelectApiEvent={() => {}}
      onSelectPresentation={() => {}}
      mobilePanel="list"
      onMobilePanelChange={() => {}}
    />,
  );

  assert.match(headerMarkup, /DEMO — data sintetis; bukan peringatan langsung/);
  assert.match(feedMarkup, /Tidak ada sumber live yang tersambung/);
  assert.match(feedMarkup, /Contoh fiktif/);
  assert.match(feedMarkup, /Daftar/);
  assert.match(feedMarkup, /Peta/);
  assert.match(feedMarkup, /bukan pernyataan bahwa area aman/);

  console.log("UI/API smoke passed: local shell, read routes, mobile switch, demo banner, and honest empty state.");
}

await runSmoke();
