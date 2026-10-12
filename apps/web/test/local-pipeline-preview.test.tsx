import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LocalPipelinePreview } from "../../worker/src/contracts/local-pipeline-preview.js";
import { routeFromHash } from "../src/App.js";
import {
  getLocalPipelinePreview,
  LocalPipelinePreviewError,
  validateLocalPipelinePreviewPayload,
} from "../src/local-pipeline-client.js";
import { LocalPipelinePreview as LocalPipelinePreviewView, LocalPipelineReportCard } from "../src/LocalPipelinePreview.js";

const generatedAt = "2026-10-12T05:30:00Z";
const canonicalText = "Laporan latihan menyebut genangan.\nCatatan latihan:\t ruas tetap dapat dilalui.";
const firstEnd = Array.from("Laporan latihan menyebut genangan.").length;
const contraryStart = Array.from(canonicalText.slice(0, canonicalText.indexOf("Catatan"))).length;
const contraryEnd = Array.from(canonicalText.slice(0, canonicalText.indexOf(" dapat dilalui.") + " dapat dilalui.".length)).length;
const textHash = "a".repeat(64);
const contentHash = "b".repeat(64);

function fixture(): LocalPipelinePreview {
  return {
    schemaVersion: "local-pipeline-preview-v1",
    datasetKind: "synthetic",
    publicationEnabled: false,
    generatedAt,
    sourceId: "local-authored-api",
    models: "mock",
    scheduler: { status: "idle", polls: 0, collectionFailures: 0 },
    summary: {
      snapshots: 1,
      ingestion: { pending: 0, leased: 0, retry: 0, completed: 1, terminal: 0 },
      ai: { pending: 0, leased: 0, retry: 0, completed: 1, terminal: 0 },
      proposals: 1,
    },
    reports: [{
      reportId: "latihan-001",
      version: 1,
      title: "Laporan <latihan> sintetis",
      publishedAt: "2026-10-12T04:55:00Z",
      observedAt: "2026-10-12T04:50:00Z",
      capturedAt: "2026-10-12T05:00:00Z",
      reportRevisionId: "local-revision:" + "c".repeat(64),
      supersedesId: null,
      contentHash,
      permittedText: canonicalText,
      permittedTextHash: textHash,
      ingestion: { status: "completed", attempts: 1, availableAt: "2026-10-12T05:00:00Z", failure: null },
      ai: { status: "completed", attempts: 1, availableAt: "2026-10-12T05:01:00Z", failure: null },
      stages: ["extraction", "embedding", "grounding", "reasoning", "proposal"],
      proposal: {
        proposalId: "proposal-" + "d".repeat(40),
        proposedAt: "2026-10-12T05:02:00Z",
        unresolvedCount: 1,
        claims: [{
          claimId: "claim-001",
          text: "<script>alert('klaim sintetis')</script>",
          assessment: "disputed",
          evidence: [
            {
              reportRevisionId: "local-revision:" + "c".repeat(64),
              permittedTextHash: textHash,
              spanStart: 0,
              spanEnd: firstEnd,
              relation: "supports",
            },
            {
              reportRevisionId: "local-revision:" + "c".repeat(64),
              permittedTextHash: textHash,
              spanStart: contraryStart,
              spanEnd: contraryEnd,
              relation: "contradicts",
            },
          ],
        }],
      },
    }],
    truncated: false,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

test("validates only bounded synthetic local preview data and returns a detached projection", () => {
  const input = fixture();
  const result = validateLocalPipelinePreviewPayload(input);

  assert.deepEqual(result, input);
  assert.notEqual(result, input);
  assert.notEqual(result.reports, input.reports);
  assert.notEqual(result.reports[0]?.stages, input.reports[0]?.stages);
});

test("rejects cross-dataset, unknown-field, malformed-lineage, and out-of-range evidence payloads", () => {
  const liveDataset = clone(fixture()) as unknown as { datasetKind: string };
  liveDataset.datasetKind = "live";
  assert.throws(() => validateLocalPipelinePreviewPayload(liveDataset), LocalPipelinePreviewError);

  const extraField = clone(fixture()) as LocalPipelinePreview & { providerError?: string };
  extraField.providerError = "do not expose";
  assert.throws(() => validateLocalPipelinePreviewPayload(extraField), LocalPipelinePreviewError);

  const extraReportField = clone(fixture());
  (extraReportField.reports[0] as LocalPipelinePreview["reports"][number] & { rawUrl?: string }).rawUrl = "https://private.invalid";
  assert.throws(() => validateLocalPipelinePreviewPayload(extraReportField), LocalPipelinePreviewError);

  const wrongEvidenceHash = clone(fixture());
  const evidence = wrongEvidenceHash.reports[0]!.proposal!.claims[0]!.evidence[0]!;
  (evidence as { permittedTextHash: string }).permittedTextHash = "f".repeat(64);
  assert.throws(() => validateLocalPipelinePreviewPayload(wrongEvidenceHash), LocalPipelinePreviewError);

  const wrongSpan = clone(fixture());
  const span = wrongSpan.reports[0]!.proposal!.claims[0]!.evidence[0]!;
  (span as { spanEnd: number }).spanEnd = Array.from(canonicalText).length + 1;
  assert.throws(() => validateLocalPipelinePreviewPayload(wrongSpan), LocalPipelinePreviewError);

  const tooManySameRelation = clone(fixture());
  const evidenceList = tooManySameRelation.reports[0]!.proposal!.claims[0]!.evidence as unknown as Array<{
    reportRevisionId: string;
    permittedTextHash: string;
    spanStart: number;
    spanEnd: number;
    relation: "supports" | "contradicts" | "updates" | "context";
  }>;
  for (let index = 0; index < 8; index += 1) evidenceList.push({
    ...evidenceList[0]!,
    spanStart: index,
    spanEnd: index + 1,
    relation: "supports",
  });
  assert.throws(() => validateLocalPipelinePreviewPayload(tooManySameRelation), LocalPipelinePreviewError);
});

test("renders source versions, separate times, escaped claim text, and contrary evidence spans", () => {
  const data = validateLocalPipelinePreviewPayload(fixture());
  const markup = renderToStaticMarkup(createElement(LocalPipelineReportCard, {
    report: data.reports[0]!,
    reports: data.reports,
  }));

  assert.match(markup, /Versi sumber 1/);
  assert.match(markup, /Diterbitkan sumber/);
  assert.match(markup, /Waktu observasi/);
  assert.match(markup, /Diterima pipeline lokal/);
  assert.match(markup, /<details class="local-pipeline__disclosure local-pipeline__source-disclosure"><summary>Identitas dan hash sumber<\/summary>/);
  assert.match(markup, /<details class="local-pipeline__disclosure local-pipeline__evidence-disclosure"><summary>Jejak referensi<\/summary>/);
  assert.doesNotMatch(markup, /<details[^>]* open(?:="")?>/);
  assert.ok(markup.indexOf("Diterbitkan sumber") < markup.indexOf("<details class=\"local-pipeline__disclosure local-pipeline__source-disclosure\">"));
  assert.match(markup, /<span>Laporan &lt;latihan&gt; sintetis · versi 1<\/span>/);
  assert.match(markup, /<blockquote>Laporan latihan menyebut genangan\.<\/blockquote>/);
  assert.ok(markup.indexOf("<blockquote>Laporan latihan menyebut genangan.</blockquote>")
    < markup.indexOf("<details class=\"local-pipeline__disclosure local-pipeline__evidence-disclosure\">"));
  assert.match(markup, /ID laporan/);
  assert.match(markup, /Rentang Unicode/);
  assert.match(markup, /Hash teks sumber/);
  assert.match(markup, /Hash konten sumber/);
  assert.match(markup, /Pribadi · belum terbit/);
  assert.match(markup, /Acuan waktu usulan \(waktu diterima pipeline\)/);
  assert.match(markup, /bukan waktu selesainya inferensi L2/);
  assert.match(markup, /Mendukung/);
  assert.match(markup, /Bertentangan/);
  assert.match(markup, /Catatan latihan:/);
  assert.match(markup, /ruas tetap dapat dilalui/);
  assert.match(markup, /&lt;script&gt;/);
  assert.doesNotMatch(markup, /<script>/);
  assert.match(markup, /Model menilai klaim|Model menilai ada pertentangan/);
});

test("the disabled local view renders a closed gate and does not expose a source error", () => {
  const markup = renderToStaticMarkup(createElement(LocalPipelinePreviewView, { enabled: false }));

  assert.match(markup, /hanya aktif pada build development setelah mode demo dikonfirmasi/);
  assert.doesNotMatch(markup, /__local\/pipeline/);
});

test("local pipeline fragment is not an active route in the Node production-like test environment", () => {
  assert.equal(routeFromHash("#pipeline-lokal").screen, "discover");
});

test("client makes a fixed read-only no-store request and validates its DTO", async () => {
  let requestedPath = "";
  let requestInit: RequestInit | undefined;
  const data = await getLocalPipelinePreview({
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedPath = String(input);
      requestInit = init;
      return new Response(JSON.stringify(fixture()), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    },
  });

  assert.equal(requestedPath, "/__local/pipeline");
  assert.equal(requestInit?.method, "GET");
  assert.equal(requestInit?.cache, "no-store");
  assert.equal(requestInit?.credentials, "same-origin");
  assert.equal(data.reports.length, 1);
});

test("client converts HTTP and oversized-body failures to a closed error", async () => {
  await assert.rejects(
    getLocalPipelinePreview({
      fetchImpl: async () => new Response("private provider error", { status: 500 }),
    }),
    (error: unknown) => error instanceof LocalPipelinePreviewError
      && !error.message.includes("private provider error"),
  );

  await assert.rejects(
    getLocalPipelinePreview({
      fetchImpl: async () => new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(512 * 1024 + 1),
        },
      }),
    }),
    LocalPipelinePreviewError,
  );
});
