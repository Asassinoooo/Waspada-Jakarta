import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createModelCapabilityAdapter } from "../../apps/worker/src/layers/l2-model-grounding/adapter.js";
import { createInvestigationPlanner } from "../../apps/worker/src/layers/l2-model-grounding/investigation-planner.js";
import { createNinerouterProvider, type NinerouterObservation } from "../../apps/worker/src/layers/l2-model-grounding/ninerouter-provider.js";
import { runSyntheticModelSmoke } from "./ninerouter-smoke.js";
import { createSyntheticModelSmokeFixtures } from "./ninerouter-fixtures.js";

const CHAT_MODEL = "Waspada-Jakarta";
const EMBEDDING_MODEL = "gemini/gemini-embedding-2-preview";

async function main(): Promise<void> {
  if (!process.argv.includes("--live")) {
    console.log(JSON.stringify({ status: "disabled", reason: "explicit_live_flag_required", datasetKind: "synthetic" }));
    return;
  }
  const baseUrl = process.env.NINEROUTER_URL;
  const apiKey = process.env.NINEROUTER_KEY;
  if (!baseUrl || !apiKey) {
    console.log(JSON.stringify({ status: "not_configured", reason: "missing_gateway_environment" }));
    process.exitCode = 1;
    return;
  }
  const startedAt = new Date().toISOString();
  const suppliedEpoch = process.env.NINEROUTER_CURATION_EPOCH;
  const epoch = suppliedEpoch ?? `local-smoke-${startedAt.replace(/[^A-Za-z0-9]/g, "")}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(epoch) || epoch.includes(apiKey)) {
    console.log(JSON.stringify({ status: "invalid_configuration", reason: "invalid_run_epoch" }));
    process.exitCode = 1;
    return;
  }
  const observations: NinerouterObservation[] = [];
  const bundle = createNinerouterProvider({
    baseUrl, apiKey, chatModel: CHAT_MODEL, embeddingModel: EMBEDDING_MODEL,
    curationEpoch: epoch, timeoutMs: 25_000, maxHttpRequests: 8, allowTailnetHttp: true,
    onObservation: (observation) => { observations.push(observation); },
  });
  const discovery = await bundle.discoverModels();
  if (!discovery.chatFound || !discovery.embeddingFound) {
    console.log(JSON.stringify({ status: "not_configured", reason: "requested_route_missing", discovery }));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ status: "catalog_verified", discovery, datasetKind: "synthetic" }));
  const adapter = createModelCapabilityAdapter(bundle.provider, bundle.configuration);
  const planner = createInvestigationPlanner(bundle.plannerProvider, bundle.plannerMetadata);
  const summary = await runSyntheticModelSmoke({ adapter, planner, signal: AbortSignal.timeout(150_000) });
  const fixtures = await createSyntheticModelSmokeFixtures();
  const artifactDirectory = resolve(process.cwd(), ".codex-build", "ai-gateway-smoke");
  await mkdir(artifactDirectory, { recursive: true });
  const artifactPath = resolve(artifactDirectory, `smoke-${startedAt.replace(/[^A-Za-z0-9]/g, "")}.json`);
  const manifest = {
    schemaVersion: "private-ai-smoke-v1", datasetKind: "synthetic", startedAt,
    finishedAt: new Date().toISOString(), epoch,
    epochSource: suppliedEpoch ? "operator_configured" : "test_run_tag",
    modelIdentityStatus: "gateway_reported_unversioned_routes",
    syntheticFixtureIdentity: {
      fixtureId: fixtures.fixtureId,
      traceId: fixtures.sufficientReasoningRequest.data.groundingContext.traceId,
      candidateId: fixtures.sufficientReasoningRequest.data.groundingContext.candidateId,
      contextIds: [fixtures.sufficientReasoningRequest.data.groundingContext.contextId, fixtures.insufficientReasoningRequest.data.groundingContext.contextId],
      chunkId: fixtures.embeddingRequest.data.chunk.chunkId,
      primaryTextHash: fixtures.reportTextHash, contraryTextHash: fixtures.contraryReportTextHash,
      embeddingRawUtf8Bytes: new TextEncoder().encode(fixtures.embeddingRequest.data.chunk.text).byteLength,
    },
    requestedRoutes: { chat: CHAT_MODEL, embedding: EMBEDDING_MODEL },
    logicalTestingConfiguration: bundle.configuration, plannerMetadata: bundle.plannerMetadata,
    discovery, observations, summary,
    boundaries: { tailnetHttpOptIn: true, databaseWrites: false, sourceAcquisitions: false, publication: false, deployment: false },
  };
  const serialized = JSON.stringify(manifest, null, 2);
  // Last guard before storing diagnostics; the manifest never includes endpoint/config secrets.
  if (serialized.includes(apiKey) || serialized.includes(baseUrl)) throw new Error("unsafe_manifest");
  await writeFile(artifactPath, `${serialized}\n`, { flag: "wx" });
  console.log(JSON.stringify({ status: summary.success ? "passed" : "failed", summary, manifestPath: artifactPath }));
  if (!summary.success) process.exitCode = 1;
}

main().catch(() => {
  // Never print provider errors, URLs, headers, request bodies or credential-bearing causes.
  console.log(JSON.stringify({ status: "failed", reason: "gateway_smoke_failed" }));
  process.exitCode = 1;
});
