import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PreviewRecord, PreviewSource, SourcePreviewPayload } from "@waspada/worker/source-preview-contracts";
import {
  getSourcePreview,
  SourcePreviewPayloadError,
  SourcePreviewTimeoutError,
  validateSourcePreviewPayload,
  type SourcePreviewClock,
} from "../src/source-preview-client.js";
import {
  SourcePreview,
  SourcePreviewRecordDetails,
  SourcePreviewRequestError,
  SourcePreviewStatusCard,
} from "../src/SourcePreview.js";

const instant = "2026-10-10T04:10:47Z";
const osmRecord: PreviewRecord = {
  id: "osm:node/123",
  source: "osm",
  kind: "hospital",
  title: "Rumah Sakit Contoh",
  coordinates: [106.82, -6.2],
  coordinate_kind: "source_point",
  source_created_at: null,
  source_status: null,
  source_url: "https://www.openstreetmap.org/node/123",
};
const floodRecord: PreviewRecord = {
  id: "petabencana:report_123",
  source: "petabencana",
  kind: "flood_report",
  title: "Laporan banjir warga",
  coordinates: [106.83, -6.19],
  coordinate_kind: "source_point",
  source_created_at: instant,
  source_status: "verified",
  source_url: "https://petabencana.id/",
};

function source(
  id: PreviewSource["id"],
  overrides: Partial<PreviewSource> = {},
): PreviewSource {
  const isOsm = id === "osm";
  return {
    id,
    status: isOsm ? "available" : "not_requested",
    data_mode: isOsm ? "snapshot" : "none",
    fetched_at: isOsm ? instant : null,
    source_updated_at: isOsm ? instant : null,
    attribution: isOsm
      ? "© OpenStreetMap contributors · ODbL 1.0"
      : "Data disediakan oleh PetaBencana.id, dilisensikan di bawah CC BY-NC 4.0.",
    license_url: isOsm
      ? "https://opendatacommons.org/licenses/odbl/1-0/"
      : "https://creativecommons.org/licenses/by-nc/4.0/",
    records: isOsm ? [osmRecord] : [],
    rejected_count: 0,
    limited: false,
    error: null,
    ...overrides,
  };
}

function payload(sources = [source("osm"), source("petabencana")]): SourcePreviewPayload {
  return {
    schema_version: "source-preview-v1",
    mode: "source_preview",
    generated_at: instant,
    cached: false,
    sources: sources as [PreviewSource, PreviewSource],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createManualClock() {
  let deadline: (() => void) | null = null;
  let delayMs = 0;
  const clock: SourcePreviewClock = {
    setTimeout(callback, delay) {
      deadline = callback;
      delayMs = delay;
      return 1;
    },
    clearTimeout() {
      deadline = null;
    },
  };
  return {
    clock,
    get delayMs() { return delayMs; },
    expire() {
      const expire = deadline;
      if (!expire) throw new Error("No active request deadline");
      deadline = null;
      expire();
    },
  };
}

test("validates the versioned DTO and returns only allowlisted fields", () => {
  const input = payload([
    source("osm"),
    source("petabencana", { status: "available", data_mode: "fetched", fetched_at: instant, records: [floodRecord] }),
  ]);
  const result = validateSourcePreviewPayload(input);

  assert.deepEqual(result, input);
  assert.notEqual(result, input);
  assert.notEqual(result.sources[0]?.records, input.sources[0]?.records);
});

test("rejects extra provider fields so citizen text cannot enter the browser DTO", () => {
  const input = clone(payload());
  const record = input.sources[0]?.records[0] as PreviewRecord & { citizen_text?: string };
  record.citizen_text = "jangan tampilkan";

  assert.throws(() => validateSourcePreviewPayload(input), SourcePreviewPayloadError);
});

test("fails closed on unsafe IDs, source links, and license links", () => {
  const badOsmUrl = clone(payload());
  (badOsmUrl.sources[0]?.records[0] as PreviewRecord).source_url = "https://example.invalid/node/123";
  assert.throws(() => validateSourcePreviewPayload(badOsmUrl), SourcePreviewPayloadError);

  const badReportUrl = clone(payload([
    source("osm"),
    source("petabencana", {
      status: "available",
      data_mode: "fetched",
      fetched_at: instant,
      records: [{ ...floodRecord, source_url: "javascript:alert(1)" }],
    }),
  ]));
  assert.throws(() => validateSourcePreviewPayload(badReportUrl), SourcePreviewPayloadError);

  const badLicense = clone(payload());
  (badLicense.sources[1] as PreviewSource).license_url = "https://example.invalid/license";
  assert.throws(() => validateSourcePreviewPayload(badLicense), SourcePreviewPayloadError);

  const badId = clone(payload());
  (badId.sources[0]?.records[0] as PreviewRecord).id = "https://example.invalid/123";
  assert.throws(() => validateSourcePreviewPayload(badId), SourcePreviewPayloadError);
});

test("rejects malformed coordinates, timestamps, and source-status combinations", () => {
  const outsideEnvelope = clone(payload());
  (outsideEnvelope.sources[0]?.records[0] as PreviewRecord).coordinates = [106.9, -6.2];
  assert.throws(() => validateSourcePreviewPayload(outsideEnvelope), SourcePreviewPayloadError);

  const invalidTime = clone(payload());
  (invalidTime.sources[0]?.records[0] as PreviewRecord).source_created_at = "besok";
  assert.throws(() => validateSourcePreviewPayload(invalidTime), SourcePreviewPayloadError);

  const inconsistentStatus = clone(payload());
  Object.assign(inconsistentStatus.sources[1], { status: "empty", data_mode: "none" });
  assert.throws(() => validateSourcePreviewPayload(inconsistentStatus), SourcePreviewPayloadError);
});

test("matches Worker source-mode outcomes, fetched timestamps, and cache rules", () => {
  const invalidSources: SourcePreviewPayload[] = [
    payload([
      source("osm", { status: "not_requested", data_mode: "none", fetched_at: null, source_updated_at: null, records: [] }),
      source("petabencana"),
    ]),
    payload([
      source("osm"),
      source("petabencana", { status: "available", data_mode: "snapshot", records: [floodRecord] }),
    ]),
    payload([
      source("osm"),
      source("petabencana", { status: "unavailable", data_mode: "none", error: "timeout" }),
    ]),
    payload([
      source("osm", { status: "unavailable", data_mode: "fetched", fetched_at: null, records: [], error: "timeout" }),
      source("petabencana"),
    ]),
    payload([
      source("osm"),
      source("petabencana", { status: "empty", data_mode: "fetched", fetched_at: instant, rejected_count: 501 }),
    ]),
    payload([
      source("osm"),
      source("petabencana", { status: "empty", data_mode: "fetched", fetched_at: instant, source_updated_at: instant }),
    ]),
  ];
  for (const invalid of invalidSources) {
    assert.throws(() => validateSourcePreviewPayload(invalid), SourcePreviewPayloadError);
  }

  const cachedSnapshot = clone(payload());
  cachedSnapshot.cached = true;
  assert.throws(() => validateSourcePreviewPayload(cachedSnapshot), SourcePreviewPayloadError);

  const futureFetch = payload([
    source("osm"),
    source("petabencana", {
      status: "empty",
      data_mode: "fetched",
      fetched_at: "2026-10-10T04:10:48Z",
    }),
  ]);
  assert.throws(() => validateSourcePreviewPayload(futureFetch), SourcePreviewPayloadError);

  const futureSourceUpdate = payload([
    source("osm", {
      status: "empty",
      data_mode: "fetched",
      records: [],
      source_updated_at: "2026-10-10T04:10:48Z",
    }),
    source("petabencana"),
  ]);
  assert.throws(() => validateSourcePreviewPayload(futureSourceUpdate), SourcePreviewPayloadError);
});

test("requires provider-specific coordinate kinds and PetaBencana report timestamps", () => {
  const nodeWithExtent = clone(payload());
  (nodeWithExtent.sources[0]?.records[0] as PreviewRecord).coordinate_kind = "source_extent_center";
  assert.throws(() => validateSourcePreviewPayload(nodeWithExtent), SourcePreviewPayloadError);

  const wayWithPoint: PreviewRecord = {
    ...osmRecord,
    id: "osm:way/123",
    source_url: "https://www.openstreetmap.org/way/123",
  };
  const invalidWay = payload([source("osm", { records: [wayWithPoint] }), source("petabencana")]);
  assert.throws(() => validateSourcePreviewPayload(invalidWay), SourcePreviewPayloadError);

  const validWay = { ...wayWithPoint, coordinate_kind: "source_extent_center" as const };
  const validWayPayload = payload([source("osm", { records: [validWay] }), source("petabencana")]);
  assert.equal(validateSourcePreviewPayload(validWayPayload).sources[0]?.records[0]?.coordinate_kind, "source_extent_center");

  const missingReportTime = payload([
    source("osm"),
    source("petabencana", {
      status: "available",
      data_mode: "fetched",
      fetched_at: instant,
      records: [{ ...floodRecord, source_created_at: null }],
    }),
  ]);
  assert.throws(() => validateSourcePreviewPayload(missingReportTime), SourcePreviewPayloadError);
});

test("accepts explicit empty and unavailable source outcomes without turning them into safety claims", () => {
  const empty = source("petabencana", { status: "empty", data_mode: "fetched", fetched_at: instant });
  const unavailable = source("osm", {
    status: "unavailable",
    data_mode: "fetched",
    fetched_at: instant,
    source_updated_at: null,
    records: [],
    error: "timeout",
  });
  assert.equal(validateSourcePreviewPayload(payload([source("osm"), empty])).sources[1]?.status, "empty");
  assert.equal(validateSourcePreviewPayload(payload([unavailable, source("petabencana")])).sources[0]?.error, "timeout");
});

test("uses only the fixed snapshot endpoint by default and the explicit fetch query on demand", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ input, init });
    return new Response(JSON.stringify(payload()), { headers: { "content-type": "application/json; charset=utf-8" } });
  };

  await getSourcePreview({ fetcher });
  await getSourcePreview({ mode: "fetch", fetcher });

  assert.equal(requests[0]?.input, "/api/v1/demo/source-preview");
  assert.equal(requests[1]?.input, "/api/v1/demo/source-preview?mode=fetch");
  assert.equal(requests[0]?.init?.method, "GET");
  assert.equal(requests[1]?.init?.cache, "no-store");
  assert.deepEqual(requests[0]?.init?.headers, { Accept: "application/json" });
});

test("passes AbortController signals and rejects oversized or non-JSON responses", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | null | undefined;
  const deadline = createManualClock();
  let fetchStarted!: () => void;
  const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
  const blockedFetcher: typeof fetch = async (_input, init) => {
    receivedSignal = init?.signal as AbortSignal | null | undefined;
    fetchStarted();
    return new Promise<Response>(() => {});
  };
  const pending = getSourcePreview({ signal: controller.signal, fetcher: blockedFetcher, clock: deadline.clock });
  await started;
  assert.equal(receivedSignal?.aborted, false);
  assert.notEqual(receivedSignal, controller.signal);
  assert.equal(deadline.delayMs, 35_000);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(receivedSignal?.aborted, true);

  const oversizedBody = new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new Uint8Array(512 * 1024 + 1)); },
    cancel() { return new Promise<void>(() => {}); },
  });
  const oversizedFetcher: typeof fetch = async () => new Response(oversizedBody, {
    headers: { "content-type": "application/json" },
  });
  await assertCompletesWithin(
    assert.rejects(
      getSourcePreview({ fetcher: oversizedFetcher, clock: createManualClock().clock }),
      SourcePreviewPayloadError,
    ),
    250,
  ).then((result) => assert.equal(result, "resolved"));

  const wrongTypeFetcher: typeof fetch = async () => new Response("{}", { headers: { "content-type": "text/html" } });
  await assert.rejects(getSourcePreview({ fetcher: wrongTypeFetcher, clock: createManualClock().clock }), SourcePreviewPayloadError);
});

test("applies the request deadline while waiting for the HTTP response", async () => {
  const deadline = createManualClock();
  let receivedSignal: AbortSignal | null | undefined;
  let fetchStarted!: () => void;
  const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
  const fetcher: typeof fetch = async (_input, init) => {
    receivedSignal = init?.signal as AbortSignal | null | undefined;
    fetchStarted();
    return new Promise<Response>(() => {});
  };

  const pending = getSourcePreview({ fetcher, clock: deadline.clock });
  await started;
  deadline.expire();
  await assert.rejects(pending, SourcePreviewTimeoutError);
  assert.equal(receivedSignal?.aborted, true);
});

test("applies the same request deadline while reading a stalled response body", async () => {
  const deadline = createManualClock();
  let bodyReadStarted!: () => void;
  const started = new Promise<void>((resolve) => { bodyReadStarted = resolve; });
  const body = new ReadableStream<Uint8Array>({
    pull() {
      bodyReadStarted();
      return new Promise<void>(() => {});
    },
    cancel() { return new Promise<void>(() => {}); },
  });
  const fetcher: typeof fetch = async () => new Response(body, {
    headers: { "content-type": "application/json" },
  });

  const pending = getSourcePreview({ fetcher, clock: deadline.clock });
  await started;
  deadline.expire();
  await assert.rejects(pending, SourcePreviewTimeoutError);
});

async function assertCompletesWithin<T>(promise: Promise<T>, milliseconds: number): Promise<"resolved" | "rejected"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => "resolved" as const, () => "rejected" as const),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Response cancellation blocked the bounded rejection")), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("shows snapshot, empty, unavailable, and per-source time labels independently", () => {
  const osm = source("osm");
  const emptyPeta = source("petabencana", { status: "empty", data_mode: "fetched", fetched_at: instant });
  const unavailablePeta = source("petabencana", {
    status: "unavailable",
    data_mode: "fetched",
    records: [],
    error: "http_error",
  });

  const notRequestedMarkup = renderToStaticMarkup(createElement(SourcePreviewStatusCard, {
    source: source("petabencana"),
    cached: false,
  }));
  const osmMarkup = renderToStaticMarkup(createElement(SourcePreviewStatusCard, { source: osm, cached: false }));
  const emptyMarkup = renderToStaticMarkup(createElement(SourcePreviewStatusCard, { source: emptyPeta, cached: false }));
  const unavailableMarkup = renderToStaticMarkup(createElement(SourcePreviewStatusCard, { source: unavailablePeta, cached: false }));

  assert.match(osmMarkup, /Snapshot lokal demo/);
  assert.match(osmMarkup, /Waktu basis data OpenStreetMap/);
  assert.match(osmMarkup, /Data diambil pada/);
  const osmDetailsMarkup = renderToStaticMarkup(createElement(SourcePreviewRecordDetails, { record: osmRecord }));
  assert.match(osmDetailsMarkup, /Perubahan fasilitas/);
  assert.match(osmMarkup, /dateTime="2026-10-10T04:10:47Z"/);
  assert.doesNotMatch(osmMarkup, /Respons demo dibuat/);
  assert.match(notRequestedMarkup, /Belum diminta/);
  assert.doesNotMatch(notRequestedMarkup, /source-preview__source-times/);
  assert.doesNotMatch(notRequestedMarkup, /Tidak tersedia dari penyedia/);
  assert.match(emptyMarkup, /Respons sumber kosong/);
  assert.match(emptyMarkup, /Hasil kosong tidak berarti Jakarta aman/);
  assert.match(unavailableMarkup, /Sumber tidak tersedia/);
  assert.match(unavailableMarkup, /Permintaan dicoba pada/);
  assert.match(unavailableMarkup, /tidak memberi respons yang dapat digunakan/);
});

test("labels source report creation time separately from physical event time and publisher status", () => {
  const markup = renderToStaticMarkup(createElement(SourcePreviewRecordDetails, { record: floodRecord }));
  assert.match(markup, /Laporan dibuat di sumber/);
  assert.match(markup, /Waktu kejadian fisik tidak tersedia dari sumber/);
  assert.match(markup, /waktu di atas hanya waktu pembuatan laporan/);
  assert.match(markup, /Status penyedia/);
  assert.match(markup, /belum diverifikasi Waspada/);
  assert.match(markup, /https:\/\/petabencana\.id\//);
});

test("offers an explicit snapshot retry only after a snapshot request fails", () => {
  const retrySnapshot = renderToStaticMarkup(createElement(SourcePreviewRequestError, {
    mode: "snapshot",
    onRetrySnapshot: () => {},
  }));
  const failedFetch = renderToStaticMarkup(createElement(SourcePreviewRequestError, {
    mode: "fetch",
    onRetrySnapshot: () => {},
  }));

  assert.match(retrySnapshot, /Coba muat snapshot/);
  assert.match(retrySnapshot, /Tidak ada data pengganti yang ditampilkan/);
  assert.doesNotMatch(failedFetch, /Coba muat snapshot/);
});

test("does not present source records or request them outside confirmed demo mode", () => {
  const liveMarkup = renderToStaticMarkup(createElement(SourcePreview, { datasetMode: "live" }));
  const unknownMarkup = renderToStaticMarkup(createElement(SourcePreview, { datasetMode: null }));

  assert.match(liveMarkup, /Tidak ada permintaan sumber yang dilakukan/);
  assert.match(liveMarkup, /tidak tersedia pada mode live/);
  assert.match(unknownMarkup, /tidak ada permintaan atau data pratinjau yang ditampilkan/);
  assert.match(liveMarkup, /belum melalui publikasi Waspada/);
  assert.match(liveMarkup, /baca lisensi ODbL/);
  assert.match(liveMarkup, /baca lisensi CC BY-NC 4\.0/);
  assert.match(liveMarkup, /Ambil, validasi &amp; normalisasi/);
  assert.match(liveMarkup, /Model\/RAG belum dijalankan/);
  assert.match(liveMarkup, /Investigasi belum dijalankan/);
  assert.match(liveMarkup, /Tampilkan pratinjau sumber/);
  assert.match(liveMarkup, /Batas, status &amp; privasi/);
});
test("uses the wider application envelope for PetaBencana, while keeping OSM facilities in the central preview window", () => {
  const petaRecord = { ...floodRecord, coordinates: [106.5, -6.3] as [number, number] };
  const petaPayload = payload([
    source("osm"),
    source("petabencana", { status: "available", data_mode: "fetched", fetched_at: instant, records: [petaRecord] }),
  ]);
  assert.deepEqual(validateSourcePreviewPayload(petaPayload).sources[1]?.records[0]?.coordinates, [106.5, -6.3]);

  const osmPayload = clone(payload());
  (osmPayload.sources[0]?.records[0] as PreviewRecord).coordinates = [106.5, -6.3];
  assert.throws(() => validateSourcePreviewPayload(osmPayload), SourcePreviewPayloadError);
});

test("rejects PetaBencana report creation times older than 24 hours or later than that source fetch", () => {
  const oldTime = new Date(Date.parse(instant) - 24 * 60 * 60 * 1000 - 1).toISOString();
  const futureTime = new Date(Date.parse(instant) + 1).toISOString();
  for (const observedAt of [oldTime, futureTime]) {
    const report = { ...floodRecord, source_created_at: observedAt };
    const input = payload([
      source("osm"),
      source("petabencana", { status: "available", data_mode: "fetched", fetched_at: instant, records: [report] }),
    ]);
    assert.throws(() => validateSourcePreviewPayload(input), SourcePreviewPayloadError);
  }
});
