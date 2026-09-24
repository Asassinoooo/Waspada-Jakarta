import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventPage, PublicContext } from "@waspada/worker/public-contracts";
import { EventFeed } from "../src/EventFeed.js";

const baseUrl = "http://127.0.0.1:5173";

async function runSmoke() {
  const uiResponse = await fetch(baseUrl);
  assert.equal(uiResponse.status, 200, "Vite should serve the local React shell");
  assert.match(await uiResponse.text(), /Waspada Jakarta/);

  const contextResponse = await fetch(`${baseUrl}/api/v1/context`);
  assert.equal(contextResponse.status, 200, "the Vite proxy should reach the Worker context route");
  const context = (await contextResponse.json()) as PublicContext;
  assert.equal(context.dataset_mode, "demo");
  assert.equal(context.dataset_label, "synthetic");
  assert.deepEqual(context.sources, []);

  const eventsResponse = await fetch(`${baseUrl}/api/v1/events`);
  assert.equal(eventsResponse.status, 200, "the Vite proxy should reach the Worker event-list route");
  const page = (await eventsResponse.json()) as EventPage;
  assert.equal(page.data.length, 2);

  const visibleMarkup = renderToStaticMarkup(
    <EventFeed status="loaded" events={page.data} context={context} />,
  );
  assert.match(visibleMarkup, /DEMO — data sintetis; bukan peringatan langsung/);
  assert.match(visibleMarkup, /Tidak ada sumber live yang terhubung/);
  assert.match(visibleMarkup, /Contoh fiktif/);

  const emptyMarkup = renderToStaticMarkup(
    <EventFeed status="loaded" events={[]} context={context} />,
  );
  assert.match(emptyMarkup, /Kekosongan data tidak berarti area aman/);

  console.log("UI/API smoke passed: local shell, both read routes, demo label, and honest empty state.");
}

await runSmoke();
