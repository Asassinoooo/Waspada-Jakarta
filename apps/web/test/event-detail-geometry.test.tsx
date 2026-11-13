import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventDetail as EventDetailRecord, HistoryPage, PublicContext, PublicGeometry } from "@waspada/worker/public-contracts";
import { EventDetail } from "../src/EventDetail.js";

const context: PublicContext = {
  dataset_mode: "live",
  dataset_label: "live",
  generated_at: "2026-11-13T10:00:00.000Z",
  sources: [],
};

const history: HistoryPage = { data: [], page: { next_cursor: null, cursor_expires_at: null } };

const baseRecord: EventDetailRecord = {
  event_id: "live-geo-01",
  version: 1,
  title: "Genangan di jalan contoh",
  summary: "Ringkasan uji untuk geometri record.",
  category: "disasters_weather",
  tags: [],
  lifecycle: "ongoing",
  freshness: {
    status: "current",
    evaluated_at: "2026-11-13T09:00:00.000Z",
    review_due_at: null,
    basis: "manual_review",
  },
  event_time: { start: null, end: null, precision: "unknown" },
  validity: { valid_from: null, valid_until: null },
  scope: { places: [], services: [], institutions: [], audiences: [] },
  claims: [],
  impacts: [],
  published_at: "2026-11-13T09:00:00.000Z",
  geometries: [],
};

const pointGeometry: PublicGeometry = {
  geometry_id: "live-geo-01-geom-1",
  role: "incident_scene",
  geometry: { type: "Point", coordinates: [106.8, -6.2] },
  precision_m: 50,
  label: "Lokasi Kejadian",
};

const outsideMapGeometry: PublicGeometry = {
  ...pointGeometry,
  geometry_id: "live-geo-01-geom-2",
  geometry: { type: "Point", coordinates: [107.3, -6.2] },
};

function renderDetail(record: EventDetailRecord, variant: "page" | "sheet" = "page"): string {
  return renderToStaticMarkup(
    <EventDetail
      mode="api-event"
      apiDetail={{ eventId: record.event_id, status: "loaded", data: record }}
      apiHistory={{ eventId: record.event_id, status: "loaded", data: history }}
      context={context}
      variant={variant}
    />,
  );
}

test("a record with point geometry on the record page draws it and never says it has no geometry", () => {
  const markup = renderDetail({ ...baseRecord, geometries: [pointGeometry] });

  assert.doesNotMatch(markup, /Tidak dipetakan/u, "a mapped record must not print the no-geometry message");
  assert.doesNotMatch(markup, /tidak menyertakan geometri/u);
  assert.match(markup, /Peta koordinat CRS84/u);
  assert.match(markup, /class="geo-feature"/u, "the record's own point is drawn");
  assert.match(markup, /1 geometri pada record ini/u);
  assert.match(markup, /106\.8, -6\.2/u, "the coordinates are the API's own, unchanged");
});

test("a record with point geometry in the #peta sheet draws it and never says it has no geometry", () => {
  const markup = renderDetail({ ...baseRecord, geometries: [pointGeometry] }, "sheet");

  assert.doesNotMatch(markup, /Tidak dipetakan/u);
  assert.match(markup, /class="geo-feature"/u);
  assert.match(markup, /1 geometri pada record ini/u);
});

test("a record whose API geometries are empty still says it is not mapped, without implying safety", () => {
  const markup = renderDetail({ ...baseRecord, geometries: [] });

  assert.match(markup, /Tidak dipetakan\. Record API ini tidak menyertakan geometri/u);
  assert.match(markup, /Tidak adanya geometri bukan pernyataan bahwa suatu area aman/u);
  assert.doesNotMatch(markup, /class="geo-feature"/u);
});

test("a response with no geometries field makes no claim that the record lacks geometry", () => {
  const record = { ...baseRecord, geometries: undefined } as unknown as EventDetailRecord;
  const markup = renderDetail(record);

  assert.doesNotMatch(markup, /Tidak dipetakan/u);
  assert.doesNotMatch(markup, /tidak menyertakan geometri/u);
  assert.match(markup, /Geometri belum tersedia dalam respons ini/u);
});

test("a geometry outside the Jakarta map area is counted as not drawn, not shown as a point or as unmapped", () => {
  const mixed = renderDetail({ ...baseRecord, geometries: [pointGeometry, outsideMapGeometry] });
  assert.doesNotMatch(mixed, /Tidak dipetakan/u);
  assert.match(mixed, /1 geometri pada record ini/u);
  assert.match(mixed, /1 geometri di luar area peta tidak digambar/u);
  assert.doesNotMatch(mixed, /107\.3/u, "an off-map coordinate is not presented as drawn");

  const onlyOutside = renderDetail({ ...baseRecord, geometries: [outsideMapGeometry] });
  assert.doesNotMatch(onlyOutside, /Tidak dipetakan/u);
  assert.match(onlyOutside, /Geometri di luar area peta/u);
  assert.doesNotMatch(onlyOutside, /class="geo-feature"/u);
});
