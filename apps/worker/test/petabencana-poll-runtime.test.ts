import assert from "node:assert/strict";
import test from "node:test";
import {
  createPetaBencanaPollRuntime,
  mapPetabencanaReportsToRevisions,
  DEFAULT_PETABENCANA_ENDPOINT,
  DEFAULT_POLL_TIMEOUT_MS,
  type StoredReportRevision,
  type PetaBencanaLeaseManager,
} from "../src/runtime/petabencana-poll-runtime.js";
import type { PetabencanaReport } from "../src/layers/l1-data-knowledge/petabencana-geojson.js";

const RETRIEVED_AT = "2026-10-26T12:00:00.000Z";

function withResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeGeoJsonFeature(options: {
  id?: string | number;
  pkey?: string;
  status?: string;
  reportType?: string;
  createdAt?: string;
  coordinates?: [number, number];
}): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    fixture_label: "test-feature",
  };
  if (options.pkey !== undefined) properties.pkey = options.pkey;
  if (options.status !== undefined) properties.status = options.status;
  if (options.reportType !== undefined) properties.report_type = options.reportType;
  if (options.createdAt !== undefined) properties.created_at = options.createdAt;

  return {
    type: "Feature",
    id: options.id,
    properties,
    geometry: options.coordinates
      ? {
          type: "Point",
          coordinates: options.coordinates,
        }
      : null,
  };
}

function makeGeoJsonCollection(features: readonly unknown[]): string {
  return JSON.stringify({
    type: "FeatureCollection",
    features,
  });
}

test("createPetaBencanaPollRuntime: polls successfully and returns StoredReportRevision matching Contract 1", async () => {
  const feature1 = makeGeoJsonFeature({
    id: "flood-monas-1",
    status: "tergenang",
    reportType: "banjir",
    createdAt: "2026-10-26T10:00:00Z",
    coordinates: [106.82715, -6.1754], // Monas (inside Jakarta envelope)
  });
  const feature2 = makeGeoJsonFeature({
    id: "flood-senayan-2",
    status: "tinggi",
    reportType: "banjir",
    createdAt: "2026-10-26T10:30:00Z",
    coordinates: [106.8015, -6.2215], // Senayan (inside Jakarta envelope)
  });

  const payload = makeGeoJsonCollection([feature1, feature2]);

  let requestedUrl = "";
  let requestedHeaders: HeadersInit | undefined;

  const mockFetch: typeof fetch = async (url, init) => {
    requestedUrl = String(url);
    requestedHeaders = init?.headers;
    return new Response(payload, {
      status: 200,
      headers: { "Content-Type": "application/geo+json" },
    });
  };

  const receivedRevisions: StoredReportRevision[] = [];
  const persistedRevisions: StoredReportRevision[] = [];

  const runtime = createPetaBencanaPollRuntime({
    fetch: mockFetch,
    now: () => RETRIEVED_AT,
    onRevisions: (revs) => {
      receivedRevisions.push(...revs);
    },
    persistence: {
      async saveRevisions(revs) {
        persistedRevisions.push(...revs);
      },
    },
  });

  const result = await runtime.pollOnce();

  assert.equal(DEFAULT_POLL_TIMEOUT_MS, 20_000);
  assert.equal(requestedUrl, DEFAULT_PETABENCANA_ENDPOINT);
  assert.ok(requestedHeaders !== undefined);
  assert.equal(result.outcome, "success");
  assert.equal(result.fetchedCount, 2);
  assert.equal(result.filteredCount, 0);
  assert.equal(result.revisions.length, 2);

  // Check callback and persistence calls
  assert.equal(receivedRevisions.length, 2);
  assert.equal(persistedRevisions.length, 2);

  // Verify first revision against Contract 1
  const rev1 = result.revisions[0];
  assert.equal(rev1.report_revision_id, "petabencana-report-flood-monas-1");
  assert.equal(rev1.source_id, "petabencana");
  assert.equal(rev1.canonical_url, "https://petabencana.id/report/flood-monas-1");
  assert.equal(rev1.revision_status, "unreviewed");
  assert.equal(rev1.published_at, "2026-10-26T10:00:00Z");
  assert.equal(rev1.retrieved_at, RETRIEVED_AT);
  assert.ok(rev1.permitted_text.includes("flood-monas-1"));
  assert.ok(rev1.permitted_text.includes("tergenang"));
  assert.match(rev1.permitted_text_hash, /^[a-f0-9]{64}$/);

  // Verify code-point chunks
  assert.equal(rev1.chunks.length, 1);
  const chunk = rev1.chunks[0];
  assert.equal(chunk.chunk_index, 0);
  assert.equal(chunk.text, rev1.permitted_text);
  assert.equal(chunk.span_start, 0);
  assert.equal(chunk.span_end, Array.from(rev1.permitted_text).length);
});

test("createPetaBencanaPollRuntime: handles API response wrapped in result object", async () => {
  const feature = makeGeoJsonFeature({
    pkey: "100293",
    status: "siaga",
    reportType: "banjir",
    createdAt: "2026-10-26T11:00:00Z",
    coordinates: [106.82, -6.18],
  });

  const wrappedPayload = JSON.stringify({
    statusCode: 200,
    result: {
      type: "FeatureCollection",
      features: [feature],
    },
  });

  const mockFetch: typeof fetch = async () =>
    new Response(wrappedPayload, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const runtime = createPetaBencanaPollRuntime({
    fetch: mockFetch,
    now: () => RETRIEVED_AT,
  });

  const result = await runtime.poll();
  assert.equal(result.outcome, "success");
  assert.equal(result.revisions.length, 1);
  assert.equal(result.revisions[0].report_revision_id, "petabencana-report-100293");
});

test("createPetaBencanaPollRuntime: filters out-of-envelope reports outside Jakarta", async () => {
  const insideJakarta = makeGeoJsonFeature({
    id: "in-jakarta",
    coordinates: [106.827, -6.175], // Jakarta Pusat
  });
  const outsideJakarta = makeGeoJsonFeature({
    id: "out-bandung",
    coordinates: [107.6098, -6.9175], // Bandung (outside envelope)
  });

  const payload = makeGeoJsonCollection([insideJakarta, outsideJakarta]);

  const mockFetch: typeof fetch = async () =>
    new Response(payload, { status: 200 });

  const runtime = createPetaBencanaPollRuntime({
    fetch: mockFetch,
    now: () => RETRIEVED_AT,
  });

  const result = await runtime.pollOnce();
  assert.equal(result.outcome, "success");
  assert.equal(result.fetchedCount, 2);
  assert.equal(result.filteredCount, 1);
  assert.equal(result.revisions.length, 1);
  assert.equal(result.revisions[0].report_revision_id, "petabencana-report-in-jakarta");
});

test("createPetaBencanaPollRuntime: handles empty reports cleanly", async () => {
  const payload = makeGeoJsonCollection([]);
  const mockFetch: typeof fetch = async () => new Response(payload, { status: 200 });

  const runtime = createPetaBencanaPollRuntime({
    fetch: mockFetch,
    now: () => RETRIEVED_AT,
  });

  const result = await runtime.pollOnce();
  assert.equal(result.outcome, "empty");
  assert.equal(result.fetchedCount, 0);
  assert.equal(result.filteredCount, 0);
  assert.deepEqual(result.revisions, []);
});

test("createPetaBencanaPollRuntime: handles timeout gracefully without throwing", async () => {
  const mockFetch: typeof fetch = async (_url, init) => {
    const { promise, reject } = withResolvers<Response>();
    init?.signal?.addEventListener("abort", () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      reject(err);
    });
    return promise;
  };
  const runtime = createPetaBencanaPollRuntime({
    fetch: mockFetch,
    timeoutMs: 50, // Short timeout for test
  });

  const result = await runtime.pollOnce();
  assert.equal(result.outcome, "error");
  assert.equal(result.revisions.length, 0);
  assert.ok(result.error?.includes("timed out") || result.error?.includes("aborted"));
});

test("createPetaBencanaPollRuntime: handles network failure gracefully without throwing", async () => {
  const mockFetch: typeof fetch = async () => {
    throw new TypeError("Failed to fetch: DNS lookup failed");
  };

  const runtime = createPetaBencanaPollRuntime({
    fetch: mockFetch,
  });

  const result = await runtime.pollOnce();
  assert.equal(result.outcome, "error");
  assert.equal(result.fetchedCount, 0);
  assert.equal(result.revisions.length, 0);
  assert.ok(result.error?.includes("DNS lookup failed"));
});

test("createPetaBencanaPollRuntime: handles HTTP non-200 responses cleanly", async () => {
  const mockFetch: typeof fetch = async () =>
    new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" });

  const runtime = createPetaBencanaPollRuntime({
    fetch: mockFetch,
  });

  const result = await runtime.pollOnce();
  assert.equal(result.outcome, "error");
  assert.equal(result.httpStatus, 503);
  assert.ok(result.error?.includes("HTTP 503"));
});

test("createPetaBencanaPollRuntime: handles malformed JSON response cleanly", async () => {
  const mockFetch: typeof fetch = async () =>
    new Response("not a valid json { broken", { status: 200 });

  const runtime = createPetaBencanaPollRuntime({
    fetch: mockFetch,
    now: () => RETRIEVED_AT,
  });

  const result = await runtime.pollOnce();
  assert.equal(result.outcome, "error");
  assert.ok(result.error?.includes("parser error") || result.error?.includes("invalid_json"));
});

test("createPetaBencanaPollRuntime: handles persistence failure cleanly without throwing", async () => {
  const feature = makeGeoJsonFeature({
    id: "f-1",
    coordinates: [106.827, -6.175],
  });
  const payload = makeGeoJsonCollection([feature]);
  const mockFetch: typeof fetch = async () => new Response(payload, { status: 200 });

  const runtime = createPetaBencanaPollRuntime({
    fetch: mockFetch,
    now: () => RETRIEVED_AT,
    persistence: {
      async saveRevisions() {
        throw new Error("DB connection pool exhausted");
      },
    },
  });

  const result = await runtime.pollOnce();
  assert.equal(result.outcome, "error");
  assert.ok(result.error?.includes("DB connection pool exhausted"));
});

test("createPetaBencanaPollRuntime: respects lease manager for slot-based idempotency", async () => {
  const leases = new Set<string>();
  const leaseManager: PetaBencanaLeaseManager = {
    async acquireLease(leaseKey: string): Promise<boolean> {
      if (leases.has(leaseKey)) return false;
      leases.add(leaseKey);
      return true;
    },
  };

  const feature = makeGeoJsonFeature({
    id: "f-lease-1",
    coordinates: [106.827, -6.175],
  });
  const payload = makeGeoJsonCollection([feature]);
  let fetchCallCount = 0;
  const mockFetch: typeof fetch = async () => {
    fetchCallCount += 1;
    return new Response(payload, { status: 200 });
  };

  const runtime = createPetaBencanaPollRuntime({
    fetch: mockFetch,
    now: () => RETRIEVED_AT,
    leaseManager,
    slotDurationMs: 60_000,
  });

  const scheduledTime = 1_700_000_000_000;

  // First poll for slot should acquire lease and execute
  const firstResult = await runtime.poll(scheduledTime);
  assert.equal(firstResult.outcome, "success");
  assert.equal(fetchCallCount, 1);

  // Second poll for identical slot should be skipped
  const secondResult = await runtime.poll(scheduledTime);
  assert.equal(secondResult.outcome, "skipped");
  assert.equal(secondResult.reason, "lease_already_held");
  assert.equal(fetchCallCount, 1); // fetch not called again
});

test("mapPetabencanaReportsToRevisions: handles Unicode code points and missing dates correctly", async () => {
  const mockReports: PetabencanaReport[] = [
    {
      featureId: "emoji-report-⚡",
      providerStatus: "banjir parah 🌊🚨",
      reportType: "banjir",
      sourceCreatedAt: null, // missing date
      sourceCreatedAtState: "missing",
      retrievedAt: RETRIEVED_AT,
      geometry: {
        type: "Point",
        coordinates: [106.82715, -6.1754],
      },
    },
  ];

  const { revisions, filteredCount } = await mapPetabencanaReportsToRevisions(mockReports, RETRIEVED_AT);
  assert.equal(filteredCount, 0);
  assert.equal(revisions.length, 1);

  const rev = revisions[0];
  assert.equal(rev.published_at, null);
  assert.equal(rev.chunks.length, 1);

  // Verify that span_end equals Unicode code-point length (handles surrogate pairs)
  const codePointCount = Array.from(rev.permitted_text).length;
  assert.equal(rev.chunks[0].span_end, codePointCount);
  assert.equal(rev.chunks[0].text, rev.permitted_text);
});
