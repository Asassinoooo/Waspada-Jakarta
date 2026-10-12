import { randomUUID } from "node:crypto";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createModelCapabilityAdapter } from "../../apps/worker/src/layers/l2-model-grounding/adapter.js";
import {
  createNinerouterProvider,
  type NinerouterObservation,
} from "../../apps/worker/src/layers/l2-model-grounding/ninerouter-provider.js";
import { createSyntheticModelSmokeFixtures } from "./ninerouter-fixtures.js";

const CHAT_MODEL = "Waspada-Jakarta";
const EMBEDDING_MODEL = "gemini/gemini-embedding-2-preview";
const MAX_RESPONSE_BODY_BYTES = 256 * 1024;
const EPOCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export interface ExtractionProbeOptions {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly manifestDirectory?: string;
  readonly signal?: AbortSignal;
  readonly log?: (record: Readonly<Record<string, unknown>>) => void;
}

interface ProbeReceipt {
  readonly status: "disabled" | "not_configured" | "invalid_configuration" | "passed" | "failed";
  readonly requestCount?: number;
  readonly elapsedMs?: number;
  readonly manifestPath?: string;
}

/**
 * Native Node transport for the one-request diagnostic. It follows no redirects,
 * sets no connection/header/body/socket timers, and buffers at most 256 KiB.
 */
export function createNoTimeoutNodeFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const requestInput = input instanceof Request ? input : undefined;
    let url: URL;
    try {
      url = new URL(requestInput?.url ?? String(input));
    } catch {
      throw new Error("request_failed");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("request_failed");

    const signal = init.signal ?? requestInput?.signal;
    if (signal?.aborted) throw new Error("aborted");
    const method = init.method ?? requestInput?.method ?? "GET";
    let headers: Record<string, string>;
    let body: string | undefined;
    try {
      const mergedHeaders = new Headers(requestInput?.headers);
      new Headers(init.headers).forEach((value, name) => mergedHeaders.set(name, value));
      headers = Object.fromEntries(mergedHeaders.entries());
      const requestBody = init.body ?? undefined;
      if (requestBody !== undefined && typeof requestBody !== "string") throw new Error("request_failed");
      body = requestBody;
    } catch {
      throw new Error("request_failed");
    }

    return new Promise<Response>((resolveResponse, rejectResponse) => {
      let settled = false;
      let outgoing: ClientRequest | undefined;
      let incoming: IncomingMessage | undefined;
      let removeAbortListener = (): void => undefined;

      const finishReject = (reason: "aborted" | "request_failed" | "response_too_large"): void => {
        if (settled) return;
        settled = true;
        removeAbortListener();
        const error = new Error(reason);
        if (reason === "aborted") error.name = "AbortError";
        rejectResponse(error);
      };

      const finishResolve = (response: Response): void => {
        if (settled) return;
        settled = true;
        removeAbortListener();
        resolveResponse(response);
      };

      const abort = (): void => {
        incoming?.destroy();
        outgoing?.destroy();
        finishReject("aborted");
      };

      if (signal) {
        signal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", abort);
        if (signal.aborted) {
          abort();
          return;
        }
      }

      try {
        const send = url.protocol === "https:" ? httpsRequest : httpRequest;
        outgoing = send(url, { method, headers, agent: false, timeout: 0 });
        outgoing.on("error", () => finishReject(signal?.aborted ? "aborted" : "request_failed"));
        outgoing.on("upgrade", (_response, socket) => {
          socket.destroy();
          finishReject("request_failed");
        });
        outgoing.on("connect", (_response, socket) => {
          socket.destroy();
          finishReject("request_failed");
        });
        outgoing.on("response", (response) => {
          incoming = response;
          const status = response.statusCode;
          if (!Number.isInteger(status) || status! < 200 || status! > 599) {
            response.destroy();
            finishReject("request_failed");
            return;
          }

          const responseHeaders = new Headers();
          try {
            const contentLength = response.headers["content-length"];
            if (typeof contentLength === "string" && /^\d+$/.test(contentLength)) {
              if (Number(contentLength) > MAX_RESPONSE_BODY_BYTES) {
                response.destroy();
                outgoing?.destroy();
                finishReject("response_too_large");
                return;
              }
              responseHeaders.set("content-length", contentLength);
            }
            const contentType = response.headers["content-type"];
            if (typeof contentType === "string") responseHeaders.set("content-type", contentType);
          } catch {
            response.destroy();
            finishReject("request_failed");
            return;
          }

          // The provider only needs the status for errors and redirects; never retain their bodies.
          if (status! >= 300 || status === 204 || status === 205 || status === 304) {
            response.destroy();
            finishResolve(new Response(null, { status: status!, headers: responseHeaders }));
            return;
          }

          const chunks: Buffer[] = [];
          let totalBytes = 0;
          response.on("data", (value: Buffer | string) => {
            if (settled) return;
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            totalBytes += chunk.byteLength;
            if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
              response.destroy();
              outgoing?.destroy();
              finishReject("response_too_large");
              return;
            }
            chunks.push(chunk);
          });
          response.on("aborted", () => finishReject(signal?.aborted ? "aborted" : "request_failed"));
          response.on("error", () => finishReject(signal?.aborted ? "aborted" : "request_failed"));
          response.on("end", () => {
            if (settled) return;
            try {
              finishResolve(new Response(Buffer.concat(chunks, totalBytes), {
                status: status!,
                headers: responseHeaders,
              }));
            } catch {
              finishReject("request_failed");
            }
          });
        });
        outgoing.end(body);
      } catch {
        finishReject("request_failed");
      }
    });
  }) as typeof fetch;
}

/** Executes the opt-in extraction once and writes only a closed, content-free manifest. */
export async function runExtractionProbe(options: ExtractionProbeOptions): Promise<ProbeReceipt> {
  const log = options.log ?? ((record: Readonly<Record<string, unknown>>) => console.log(JSON.stringify(record)));
  if (!options.argv.includes("--live") || !options.argv.includes("--no-timeout")) {
    const receipt = { status: "disabled", reason: "explicit_live_and_no_timeout_flags_required" } as const;
    log(receipt);
    return receipt;
  }

  const baseUrl = options.env.NINEROUTER_URL;
  const apiKey = options.env.NINEROUTER_KEY;
  if (!baseUrl || !apiKey) {
    const receipt = { status: "not_configured", reason: "missing_gateway_environment" } as const;
    log(receipt);
    return receipt;
  }

  const startedAt = new Date().toISOString();
  const started = performance.now();
  const suppliedEpoch = options.env.NINEROUTER_CURATION_EPOCH;
  const epoch = suppliedEpoch ?? `test-run-${startedAt.replace(/[^A-Za-z0-9]/g, "")}`;
  if (!EPOCH_PATTERN.test(epoch) || epoch.toLowerCase().includes(apiKey.toLowerCase())) {
    const receipt = { status: "invalid_configuration", reason: "invalid_run_epoch" } as const;
    log(receipt);
    return receipt;
  }

  const fixtures = await createSyntheticModelSmokeFixtures();
  const observations: NinerouterObservation[] = [];
  let requestCount = 0;
  const transportKind = options.fetchImpl ? "injected_test_transport" : "native_node_http";
  const underlyingFetch = options.fetchImpl ?? createNoTimeoutNodeFetch();
  const guardedFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (requestCount >= 1) throw new Error("request_limit");
    requestCount += 1;
    const signal = combineSignals(options.signal, init.signal);
    return underlyingFetch(input, { ...init, ...(signal ? { signal } : {}) });
  }) as typeof fetch;

  let outcome;
  try {
    const bundle = createNinerouterProvider({
      baseUrl,
      apiKey,
      chatModel: CHAT_MODEL,
      embeddingModel: EMBEDDING_MODEL,
      curationEpoch: epoch,
      timeoutMs: null,
      maxHttpRequests: 1,
      allowTailnetHttp: true,
      onObservation: (observation) => { observations.push(observation); },
    }, guardedFetch);
    const adapter = createModelCapabilityAdapter(bundle.provider, bundle.configuration);
    log({ status: "pending", capability: "extraction", datasetKind: "synthetic" });
    outcome = await adapter.extract(fixtures.extractionRequest);
  } catch {
    const receipt = { status: "invalid_configuration", reason: "probe_setup_failed" } as const;
    log(receipt);
    return receipt;
  }

  const elapsedMs = finiteDuration(performance.now() - started);
  const finishedAt = new Date().toISOString();
  const value = outcome.status === "succeeded" ? outcome.value : undefined;
  const lineageMatches = value === undefined ? null : (
    value.candidateId === fixtures.extractionRequest.data.candidateId
    && value.reportRevisionId === fixtures.extractionRequest.data.report.reportRevisionId
    && value.permittedTextHash === fixtures.reportTextHash
    && value.evidence.every((reference) => (
      reference.reportRevisionId === fixtures.extractionRequest.data.report.reportRevisionId
      && reference.permittedTextHash === fixtures.reportTextHash
      && reference.spanEnd <= Array.from(fixtures.reportText).length
    ))
  );
  const observation = observations.find((entry) => entry.capability === "extraction");
  const status: "passed" | "failed" = outcome.status === "succeeded"
    && lineageMatches === true
    && requestCount === 1
    && observation?.outcome === "succeeded"
    ? "passed"
    : "failed";
  const safeObservation = observation ? {
    capability: "extraction",
    requestedRoute: CHAT_MODEL,
    outcome: observation.outcome,
    ...(observation.reason ? { reason: observation.reason } : {}),
    ...(observation.httpStatus === undefined ? {} : { httpStatus: observation.httpStatus }),
    durationMs: observation.durationMs,
    usage: observation.usage,
  } : {
    capability: "extraction",
    requestedRoute: CHAT_MODEL,
    outcome: "not_observed",
    durationMs: 0,
    usage: { status: "unavailable", reason: "missing_or_invalid" },
  };
  const manifest = {
    schemaVersion: "extraction-no-timeout-probe-v1",
    datasetKind: "synthetic",
    startedAt,
    finishedAt,
    elapsedMs,
    status,
    clientDeadlineMs: null,
    transportKind,
    epoch,
    epochSource: suppliedEpoch ? "operator_configured" : "test_run_tag",
    fixture: {
      fixtureId: fixtures.fixtureId,
      candidateId: fixtures.extractionRequest.data.candidateId,
      reportRevisionId: fixtures.extractionRequest.data.report.reportRevisionId,
      permittedTextHash: fixtures.reportTextHash,
      spanStart: 0,
      spanEnd: Array.from(fixtures.reportText).length,
      offsetUnit: "unicode_code_points",
    },
    requestCount,
    result: value ? {
      status: "succeeded",
      schemaVersion: "2.0",
      recordType: "ExtractionResult",
      lineageMatches,
      category: value.category,
      eventTimePrecision: value.eventTime.precision,
      counts: {
        tags: value.tags.length,
        evidence: value.evidence.length,
        unknownFields: value.unknownFields.length,
        placeIds: value.scope.placeIds.length,
        serviceIds: value.scope.serviceIds.length,
        institutionIds: value.scope.institutionIds.length,
        audienceIds: value.scope.audienceIds.length,
        geometryIds: value.scope.geometryIds.length,
      },
      evidenceRelations: value.evidence.map((reference) => ({
        reportRevisionId: reference.reportRevisionId,
        permittedTextHash: reference.permittedTextHash,
        spanStart: reference.spanStart,
        spanEnd: reference.spanEnd,
        offsetUnit: reference.offsetUnit,
        relation: reference.relation,
      })),
    } : {
      status: outcome.status,
      schemaVersion: null,
      recordType: null,
      lineageMatches: null,
      counts: null,
    },
    observation: safeObservation,
    boundaries: {
      extractionOnly: true,
      schemaValidated: outcome.status === "succeeded",
      databaseWrites: false,
      sourceAcquisitions: false,
      embeddings: false,
      reasoning: false,
      planner: false,
      publication: false,
      semanticOracle: false,
      fullSmoke: false,
    },
  };

  const manifestDirectory = options.manifestDirectory
    ?? resolve(process.cwd(), ".codex-build", "ai-extraction-probe");
  await mkdir(manifestDirectory, { recursive: true });
  const manifestPath = resolve(manifestDirectory, `probe-${randomUUID()}.json`);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (serialized.includes(apiKey) || serialized.includes(baseUrl) || serialized.includes(fixtures.reportText)) {
    log({ status: "failed", reason: "unsafe_manifest_rejected" });
    return { status: "failed", requestCount, elapsedMs };
  }
  await writeFile(manifestPath, serialized, { flag: "wx" });

  const receipt: ProbeReceipt = { status, requestCount, elapsedMs, manifestPath };
  log({ ...receipt });
  return receipt;
}

function combineSignals(primary?: AbortSignal, secondary?: AbortSignal | null): AbortSignal | undefined {
  if (!primary) return secondary ?? undefined;
  if (!secondary || primary === secondary) return primary;
  return AbortSignal.any([primary, secondary]);
}

function finiteDuration(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const receipt = await runExtractionProbe({
      argv: process.argv.slice(2),
      env: process.env,
      signal: controller.signal,
    });
    if (receipt.status === "failed" || receipt.status === "not_configured" || receipt.status === "invalid_configuration") {
      process.exitCode = 1;
    }
  } catch {
    console.log(JSON.stringify({ status: "failed", reason: "probe_failed" }));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
