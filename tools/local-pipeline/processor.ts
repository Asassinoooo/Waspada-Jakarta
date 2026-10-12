import { createHash } from 'node:crypto';
import { JOB_QUEUE_POLICY } from '../../apps/db/src/queue.js';
import type { TransactionalSqlExecutor, SqlExecutor } from '../../apps/db/src/sql.js';
import { createRepositoryPorts } from '../../apps/db/src/ports.js';
import { createSqlExactEvidenceSpanReader } from '../../apps/db/src/evidence-retrieval.js';
import type { ExtractionResultRecord } from '../../apps/db/src/extraction-results.js';
import type { EmbeddingRunRecord } from '../../apps/db/src/embedding-runs.js';
import type { GroundingContextRecord } from '../../apps/db/src/grounding-contexts.js';
import type {
  EmbeddingRequest,
  EmbeddingResult,
  ExtractionRequest,
  ExtractionResult,
  ModelAdapterConfiguration,
  ModelCapabilityAdapter,
  ReasoningRequest,
  ReasoningResult,
} from '../../apps/worker/src/layers/l2-model-grounding/contracts.js';
import { createDirectReasoningService } from '../../apps/worker/src/layers/l2-model-grounding/direct-reasoning.js';
import { assembleGroundingReasoningRequest } from '../../apps/worker/src/layers/l2-model-grounding/grounding-context.js';
import { createReasoningContextPersister } from '../../apps/worker/src/layers/l2-model-grounding/context-persistence.js';
import { createReasoningProposalBridge } from '../../apps/worker/src/layers/l2-model-grounding/reasoning-proposal-bridge.js';
import {
  parseEmbeddingOutput,
  parseExtractionOutput,
  parseReasoningOutput,
} from '../../apps/worker/src/layers/l2-model-grounding/validation.js';
import { chunkPreparedText } from '../../apps/worker/src/layers/l1-data-knowledge/evidence-chunking.js';
import { NORMALIZATION_VERSION, preparePermittedText } from '../../apps/worker/src/layers/l1-data-knowledge/text-preparation.js';
import type {
  AiJob,
  AiStage,
  LocalPipelineStore,
  ReportSnapshot,
  SafeFailure,
} from './contracts.js';
import { LOCAL_PIPELINE_SCHEMA, LOCAL_SOURCE_ID } from './contracts.js';

const DEFAULT_MODEL_TIMEOUT_MS = 26_000;
const MAX_MODEL_TIMEOUT_MS = 901_000;
const LONG_WAIT_RENEWAL_THRESHOLD_MS = 60_000;
const DEFAULT_LEASE_RENEW_INTERVAL_MS = 60_000;
const MAX_LEASE_RENEW_INTERVAL_MS = 60_000;
const RETRIEVAL_MAX_RESULTS = 8;
const RETRIEVAL_MAX_ROWS = 16;
const RETRIEVAL_MAX_SPAN_CODE_POINTS = 2_048;

export interface LocalPipelineProcessorInput {
  readonly store: LocalPipelineStore;
  readonly executor: TransactionalSqlExecutor;
  readonly adapter: ModelCapabilityAdapter;
  readonly configuration: ModelAdapterConfiguration;
  readonly now: () => string;
  readonly modelTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly cancel?: () => void;
  readonly leaseRenewIntervalMs?: number;
}

export interface LocalPipelineProcessor {
  /** Drains captured L1 jobs. Each job uses its immutable queue snapshot. */
  processIngestion(): Promise<unknown>;
  /** Processes at most one AI job so every model cycle stays bounded. */
  processAi(): Promise<unknown>;
}

class ProcessorFailure extends Error {
  constructor(readonly code: SafeFailure) {
    super(code);
    this.name = 'ProcessorFailure';
  }
}

class ModelTimeout extends Error {
  constructor() {
    super('model_timeout');
    this.name = 'ModelTimeout';
  }
}

interface StageReceipt {
  readonly schemaVersion: typeof LOCAL_PIPELINE_SCHEMA;
  readonly jobId: string;
  readonly stage: AiStage;
  readonly snapshotKey: string;
  readonly configurationKey: string;
  readonly payload: unknown;
}

interface PreparedSnapshot {
  readonly prepared: Awaited<ReturnType<typeof preparePermittedText>>;
  readonly chunks: Awaited<ReturnType<typeof chunkPreparedText>>;
}

interface LeaseRenewingStore extends LocalPipelineStore {
  renewAi(job: AiJob, now: string, leaseDurationMs?: number): Promise<boolean>;
}

interface AiLeaseGuard {
  readonly leaseLost: boolean;
  assertActive(): void;
  markLeaseLost(): void;
  runFenced<T>(operation: () => Promise<T>): Promise<T>;
  runRelease<T>(operation: () => Promise<T>): Promise<T>;
  runModel<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T>;
  stop(): Promise<void>;
}

class LeaseControlFailure extends Error {
  constructor(readonly kind: 'lease_lost' | 'cancelled') {
    super(kind === 'lease_lost' ? 'lease_expired' : 'model_cancelled');
    this.name = 'LeaseControlFailure';
  }
}

export function createLocalPipelineProcessor(input: LocalPipelineProcessorInput): LocalPipelineProcessor {
  const { store, executor, adapter, configuration, now } = input;
  const modelTimeoutMs = input.modelTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
  if (!Number.isSafeInteger(modelTimeoutMs) || modelTimeoutMs < 1 || modelTimeoutMs > MAX_MODEL_TIMEOUT_MS) {
    throw new TypeError('modelTimeoutMs is outside the bounded local range');
  }
  const leaseRenewIntervalMs = input.leaseRenewIntervalMs ?? DEFAULT_LEASE_RENEW_INTERVAL_MS;
  if (!Number.isSafeInteger(leaseRenewIntervalMs) || leaseRenewIntervalMs < 1
    || leaseRenewIntervalMs > MAX_LEASE_RENEW_INTERVAL_MS
    || leaseRenewIntervalMs >= JOB_QUEUE_POLICY.maxLeaseDurationMs) {
    throw new TypeError('leaseRenewIntervalMs is outside the bounded local range');
  }
  const basePorts = createRepositoryPorts(executor);
  const exactSpanReader = createSqlExactEvidenceSpanReader(executor);
  const configurationKey = hash(stableStringify(configuration));

  return {
    async processIngestion(): Promise<unknown> {
      const job = await store.claimIngestion(now());
      if (!job) return await store.summary();
      const snapshot = await store.ingestionSnapshot(job.jobId);
      if (!snapshot) {
        await store.failIngestion(job, now(), 'l1_failed');
        return await store.summary();
      }

      let prepared: PreparedSnapshot;
      try {
        prepared = await prepareSnapshot(snapshot);
      } catch {
        await store.failIngestion(job, now(), 'l1_failed');
        return await store.summary();
      }

      try {
        const committed = await store.finishIngestion(job, now(), async (transaction, callbackSnapshot) => {
          if (!sameSnapshotIdentity(snapshot, callbackSnapshot)) throw new ProcessorFailure('l1_failed');
          const tx = joinTransaction(transaction);
          const ports = createRepositoryPorts(tx);
          if (callbackSnapshot.sourceId !== LOCAL_SOURCE_ID || callbackSnapshot.datasetKind !== 'synthetic') {
            throw new ProcessorFailure('l1_failed');
          }
          if (callbackSnapshot.supersedesId) {
            const prior = await ports.reportRevisions.findById('synthetic', callbackSnapshot.supersedesId);
            if (!prior || prior.sourceId !== callbackSnapshot.sourceId) {
              throw new ProcessorFailure('prerequisite_pending');
            }
          }

          // capture() creates this open trace atomically with the immutable snapshot.
          // Revision and evidence writers enforce that the captured trace exists.

          const revisionRecord = makeRevisionRecord(callbackSnapshot, prepared.prepared.permittedText,
            prepared.prepared.permittedTextHash, prepared.prepared.normalizationVersion);
          await ports.reportRevisions.create(revisionRecord);
          const originId = originIdFor(callbackSnapshot);
          await persistOrigin(tx, callbackSnapshot, originId);
          const fullSpanEnd = Array.from(prepared.prepared.permittedText).length;
          const contextReferenceId = await ports.reportRevisions.createEvidenceReference({
            datasetKind: 'synthetic',
            traceId: callbackSnapshot.traceId,
            reportRevisionId: callbackSnapshot.reportRevisionId,
            permittedTextHash: prepared.prepared.permittedTextHash,
            spanStart: 0,
            spanEnd: fullSpanEnd,
            relation: 'context',
          });
          await persistOriginEvidence(tx, originId, contextReferenceId);
          await ports.evidenceChunks.persist({
            datasetKind: 'synthetic',
            traceId: callbackSnapshot.traceId,
            reportRevisionId: callbackSnapshot.reportRevisionId,
            permittedTextHash: prepared.prepared.permittedTextHash,
            normalizationVersion: prepared.prepared.normalizationVersion,
            chunks: prepared.chunks,
          });
        });
        // A false result is a fenced lease miss. There is nothing safe to retry here.
        if (!committed) return await store.summary();
      } catch (error) {
        const code = error instanceof ProcessorFailure ? error.code : 'persistence_failed';
        await store.failIngestion(job, now(), code);
      }
      return await store.summary();
    },

    async processAi(): Promise<unknown> {
      if (input.signal?.aborted) return await store.summary();
      const job = await store.claimAi(now(), JOB_QUEUE_POLICY.maxLeaseDurationMs);
      if (!job) return await store.summary();
      const lease = createAiLeaseGuard({
        job,
        store,
        now,
        signal: input.signal,
        cancel: input.cancel,
        renew: modelTimeoutMs > LONG_WAIT_RENEWAL_THRESHOLD_MS,
        renewIntervalMs: leaseRenewIntervalMs,
      });
      let failure: unknown;
      try {
        lease.assertActive();
        await processOneAiJob(job, lease);
      } catch (error) {
        failure = error;
      }
      // No timer or in-flight renewal may outlive a completion/failure transition.
      await lease.stop();
      if (failure === undefined) {
        try {
          const completed = await lease.runFenced(() => store.completeAi(job, now()));
          if (!completed) {
            lease.markLeaseLost();
            failure = new LeaseControlFailure('lease_lost');
          }
        } catch (error) {
          failure = error;
        }
      }
      if (failure !== undefined && !lease.leaseLost) {
        const code = failure instanceof ProcessorFailure
          ? failure.code
          : failure instanceof ModelTimeout
            ? 'model_timeout'
            : failure instanceof LeaseControlFailure
              ? failure.kind === 'cancelled' ? 'model_failed' : 'lease_expired'
              : 'persistence_failed';
        try {
          await lease.runRelease(() => store.failAi(job, now(), code));
        } catch {
          // The lease may have expired while the processor was stopping. Recovery owns it then.
        }
      }
      return await store.summary();
    },
  };

  async function checkpointAi(
    job: AiJob,
    lease: AiLeaseGuard,
    stage: AiStage,
    value: unknown,
    write?: (transaction: TransactionalSqlExecutor) => Promise<void>,
  ): Promise<void> {
    const committed = await lease.runFenced(() => store.checkpoint(job, now(), stage, value, async (transaction) => {
      lease.assertActive();
      if (write) await write(transaction);
      lease.assertActive();
    }));
    if (!committed) {
      lease.markLeaseLost();
      throw new LeaseControlFailure('lease_lost');
    }
  }

  async function processOneAiJob(job: AiJob, lease: AiLeaseGuard): Promise<void> {
    lease.assertActive();
    if (!job.leaseToken || !job.leaseExpiresAt
      || job.snapshot.sourceId !== LOCAL_SOURCE_ID || job.snapshot.datasetKind !== 'synthetic') {
      throw new ProcessorFailure('lease_expired');
    }
    const snapshot = job.snapshot;
    const { prepared, chunks } = await prepareSnapshot(snapshot);
    if (chunks.length !== 1) throw new ProcessorFailure('context_insufficient');
    const snapshotKey = snapshotIdentity(snapshot);
    const extractionRequest: ExtractionRequest = {
      data: {
        candidateId: snapshot.candidateId,
        report: {
          reportRevisionId: snapshot.reportRevisionId,
          permittedTextHash: prepared.permittedTextHash,
          normalizationVersion: prepared.normalizationVersion,
          permittedText: prepared.permittedText,
        },
      },
    };

    let extraction = await readStageReceipt<ExtractionResult>(job, 'extraction', snapshotKey,
      (value) => validateExtractionReceipt(value, extractionRequest, configuration));
    if (!extraction) {
      const outcome = await lease.runModel(() => adapter.extract(extractionRequest), modelTimeoutMs);
      extraction = requireCapability(outcome, 'extraction');
      const receipt = makeReceipt(job, 'extraction', snapshotKey, { result: extraction });
      const record = toExtractionRecord(extraction, snapshot);
      await checkpointAi(job, lease, 'extraction', receipt, async (transaction) => {
        const tx = joinTransaction(transaction);
        const ports = createRepositoryPorts(tx);
        const originId = originIdFor(snapshot);
        for (const reference of extraction!.evidence) {
          const evidenceReferenceId = await ports.reportRevisions.createEvidenceReference({
            datasetKind: 'synthetic',
            traceId: snapshot.traceId,
            reportRevisionId: reference.reportRevisionId,
            permittedTextHash: reference.permittedTextHash,
            spanStart: reference.spanStart,
            spanEnd: reference.spanEnd,
            relation: reference.relation,
          });
          await persistOriginEvidence(tx, originId, evidenceReferenceId);
        }
        await ports.extractionResults.createOrVerify(record);
      });
    }

    const chunk = chunks[0];
    if (!chunk) throw new ProcessorFailure('context_insufficient');
    const modelChunk = {
      chunkId: chunk.chunkId,
      reportRevisionId: chunk.reportRevisionId,
      permittedTextHash: chunk.permittedTextHash,
      normalizationVersion: chunk.normalizationVersion,
      spanStart: chunk.spanStart,
      spanEnd: chunk.spanEnd,
      offsetUnit: chunk.offsetUnit,
      chunkTextHash: chunk.chunkTextHash,
      text: chunk.text,
    } as const;
    const embeddingRequest: EmbeddingRequest = { data: { chunk: modelChunk } };
    let embedding = await readStageReceipt<EmbeddingResult>(job, 'embedding', snapshotKey,
      (value) => validateEmbeddingReceipt(value, embeddingRequest, configuration));
    if (!embedding) {
      const outcome = await lease.runModel(() => adapter.embed(embeddingRequest), modelTimeoutMs);
      embedding = requireCapability(outcome, 'embedding');
      const record = toEmbeddingRecord(embedding, snapshot);
      const receipt = makeReceipt(job, 'embedding', snapshotKey, { result: embedding });
      await checkpointAi(job, lease, 'embedding', receipt, async (transaction) => {
        const tx = joinTransaction(transaction);
        const ports = createRepositoryPorts(tx);
        await ports.embeddingRuns.createOrVerify(record, embedding!.vector);
      });
    }

    const retrieval = await basePorts.evidenceRetrieval.search({
      datasetKind: 'synthetic',
      identifiers: [{ kind: 'candidate', value: snapshot.candidateId }],
      semantic: {
        identity: requiredEmbeddingIdentity(configuration),
        queryVector: embedding.vector,
      },
      filters: {
        revisionStatuses: ['unreviewed'],
        registryStatuses: ['active'],
        approvalStatuses: ['approved'],
      },
      maxResults: RETRIEVAL_MAX_RESULTS,
      maxRowsExamined: RETRIEVAL_MAX_ROWS,
      maxSpanTextCodePoints: RETRIEVAL_MAX_SPAN_CODE_POINTS,
    });
    if (retrieval.scanTruncated || retrieval.resultTruncated || retrieval.invalidSpanRowsOmitted > 0) {
      throw new ProcessorFailure('context_insufficient');
    }
    // Hybrid retrieval is an OR across identifier and semantic facets, so unrelated semantic matches can be present.
    // Validate truncation across the full search above, then scope assembly to this synthetic candidate while keeping
    // every relation and revision returned for that candidate.
    const scopedRetrieval = {
      ...retrieval,
      candidates: retrieval.candidates.filter((candidate) => candidate.datasetKind === 'synthetic'
        && candidate.candidateId === snapshot.candidateId),
    };
    const selectedEvidence = extraction.evidence.map((reference) => {
      const matches = scopedRetrieval.candidates.filter((candidate) => candidate.reportRevisionId === snapshot.reportRevisionId
        && candidate.permittedTextHash === prepared.permittedTextHash
        && candidate.spanStart === reference.spanStart && candidate.spanEnd === reference.spanEnd
        && candidate.relation === reference.relation);
      // Retrieval returns a bounded preview; the grounding assembler rehydrates the full exact span below.
      if (matches.length !== 1) throw new ProcessorFailure('context_insufficient');
      return { reference, evidenceReferenceId: matches[0]!.evidenceReferenceId };
    });
    if (selectedEvidence.length < 1 || selectedEvidence.length > 8
      || !selectedEvidence.some(({ reference }) => reference.relation === 'supports')) {
      throw new ProcessorFailure('context_insufficient');
    }
    const selectedEvidenceIds = selectedEvidence.map(({ evidenceReferenceId }) => evidenceReferenceId);
    const missingFields = [...extraction.unknownFields];
    const conflicts = selectedEvidence
      .filter(({ reference }) => reference.relation === 'contradicts')
      .map(({ reference }) => `extraction_contradiction:${snapshot.reportRevisionId}:${reference.spanStart}:${reference.spanEnd}`);
    const contextId = `context-${hash(snapshotKey).slice(0, 40)}`;
    const groundingRequest = await assembleGroundingReasoningRequest(exactSpanReader, {
      retrieval: scopedRetrieval,
      datasetKind: 'synthetic',
      traceId: snapshot.traceId,
      contextId,
      candidateId: snapshot.candidateId,
      evidenceReferenceIds: selectedEvidenceIds,
      candidateEvents: [],
      priorDecisionIds: [],
      missingFields,
      conflicts,
      // This only marks that the private request has an exact support reference. It is not fact verification or publication eligibility.
      sufficient: true,
    }).catch(() => { throw new ProcessorFailure('context_insufficient'); });
    const contextPersistence = createReasoningContextPersister({
      async createOrVerify(record) { return record; },
    });
    const persistedContext = await contextPersistence.persist(groundingRequest)
      .catch(() => { throw new ProcessorFailure('context_insufficient'); });
    const groundingRecord = persistedContext.persistedRecord;
    const groundingReceipt = await readStageReceipt<GroundingContextRecord>(job, 'grounding', snapshotKey,
      (value) => validateGroundingReceipt(value, groundingRecord));
    if (!groundingReceipt) {
      await checkpointAi(job, lease, 'grounding', makeReceipt(job, 'grounding', snapshotKey,
        { record: groundingRecord }), async (transaction) => {
        await createRepositoryPorts(joinTransaction(transaction)).groundingContexts.createOrVerify(groundingRecord);
      });
    }

    const reasoningRequest = persistedContext.reasoningRequest;
    const reasonConfig = configuration.reasoning;
    if (!reasonConfig) throw new ProcessorFailure('model_failed');
    let reasoning = await readStageReceipt<ReasoningResult>(job, 'reasoning', snapshotKey,
      (value) => validateReasoningReceipt(value, reasoningRequest, configuration));
    if (!reasoning) {
      lease.assertActive();
      const directReasoning = createDirectReasoningService({
        async persist(request) {
          return await lease.runFenced(() => contextPersistence.persist(request));
        },
      }, {
        async reason(request) {
          return await lease.runModel(() => adapter.reason(request), modelTimeoutMs);
        },
      });
      const directOutcome = await directReasoning.reason(reasoningRequest);
      if (directOutcome.status === 'investigation_required') throw new ProcessorFailure('context_insufficient');
      reasoning = requireCapability(directOutcome, 'reasoning');
      const reasonReceipt = makeReceipt(job, 'reasoning', snapshotKey, { result: reasoning });
      await checkpointAi(job, lease, 'reasoning', reasonReceipt);
    }

    const proposalId = `proposal-${hash(snapshotKey).slice(0, 40)}`;
    const proposalPayload = {
      proposalId,
      contextId,
      candidateId: snapshot.candidateId,
      status: 'persisted',
    } as const;
    const existingProposalReceipt = await readStageReceipt<typeof proposalPayload>(job, 'proposal', snapshotKey,
      (value) => validateProposalReceipt(value, proposalPayload));
    if (!existingProposalReceipt) {
      lease.assertActive();
      const proposalInput = {
        capabilityOutcome: { status: 'succeeded', capability: 'reasoning', value: reasoning } as const,
        groundingContext: reasoningRequest.data.groundingContext,
        persistedContextRecord: groundingRecord,
        proposalId,
        proposedAt: snapshot.capturedAt,
        target: { kind: 'new' } as const,
        investigationId: null,
      };
      await checkpointAi(job, lease, 'proposal', makeReceipt(job, 'proposal', snapshotKey,
        { record: proposalPayload }), async (transaction) => {
        const txPorts = createRepositoryPorts(joinTransaction(transaction));
        const txBridge = createReasoningProposalBridge(txPorts.eventProposals);
        const result = await txBridge.persist(proposalInput);
        if (result.status !== 'persisted') throw new ProcessorFailure('invalid_output');
        const traceClosed = await txPorts.tracesAndAudit.finishTrace(
          snapshot.traceId,
          'synthetic',
          now(),
          'succeeded',
          { pipeline: LOCAL_PIPELINE_SCHEMA, proposalId },
        );
        if (!traceClosed) throw new ProcessorFailure('persistence_failed');
      });
    }
    lease.assertActive();
  }

  async function prepareSnapshot(snapshot: ReportSnapshot): Promise<PreparedSnapshot> {
    if (!snapshot || snapshot.sourceId !== LOCAL_SOURCE_ID || snapshot.datasetKind !== 'synthetic'
      || typeof snapshot.text !== 'string' || typeof snapshot.reportRevisionId !== 'string') {
      throw new ProcessorFailure('l1_failed');
    }
    const prepared = await preparePermittedText(snapshot.text);
    if (prepared.normalizationVersion !== NORMALIZATION_VERSION) throw new ProcessorFailure('l1_failed');
    const chunks = await chunkPreparedText('synthetic', snapshot.reportRevisionId, prepared);
    return { prepared, chunks };
  }

  async function readStageReceipt<T>(
    job: AiJob,
    stage: AiStage,
    snapshotKey: string,
    validate: (value: unknown) => Promise<T>,
  ): Promise<T | null> {
    const raw = await store.readReceipt(job.jobId, stage);
    if (raw === null || raw === undefined) return null;
    const envelope = exactRecord(raw, ['schemaVersion', 'jobId', 'stage', 'snapshotKey', 'configurationKey', 'payload']);
    if (envelope.schemaVersion !== LOCAL_PIPELINE_SCHEMA || envelope.jobId !== job.jobId || envelope.stage !== stage
      || envelope.snapshotKey !== snapshotKey || envelope.configurationKey !== configurationKey) {
      throw new ProcessorFailure('persistence_failed');
    }
    return await validate(envelope.payload);
  }

  function makeReceipt(job: AiJob, stage: AiStage, snapshotKey: string, payload: unknown): StageReceipt {
    return { schemaVersion: LOCAL_PIPELINE_SCHEMA, jobId: job.jobId, stage, snapshotKey, configurationKey, payload };
  }

  async function validateExtractionReceipt(value: unknown, request: ExtractionRequest, config: ModelAdapterConfiguration): Promise<ExtractionResult> {
    const envelope = exactRecord(value, ['result']);
    const result = envelope.result as ExtractionResult;
    if (!config.extraction || !result || typeof result !== 'object') throw new ProcessorFailure('persistence_failed');
    const reparsed = await parseExtractionOutput({
      output: {
        category: result.category,
        tags: result.tags,
        eventTime: result.eventTime,
        scope: result.scope,
        evidence: result.evidence,
        unknownFields: result.unknownFields,
      },
      usage: { inputTokens: result.modelRun?.inputTokens, outputTokens: result.modelRun?.outputTokens },
    }, request, config.extraction);
    if (stableStringify(reparsed) !== stableStringify(result)) throw new ProcessorFailure('persistence_failed');
    return reparsed;
  }

  async function validateEmbeddingReceipt(value: unknown, request: EmbeddingRequest, config: ModelAdapterConfiguration): Promise<EmbeddingResult> {
    const envelope = exactRecord(value, ['result']);
    const result = envelope.result as EmbeddingResult;
    if (!config.embedding || !result || typeof result !== 'object') throw new ProcessorFailure('persistence_failed');
    const reparsed = await parseEmbeddingOutput({ vector: result.vector }, request, config.embedding);
    if (stableStringify(reparsed) !== stableStringify(result)) throw new ProcessorFailure('persistence_failed');
    return reparsed;
  }

  async function validateReasoningReceipt(value: unknown, request: ReasoningRequest, config: ModelAdapterConfiguration): Promise<ReasoningResult> {
    const envelope = exactRecord(value, ['result']);
    const result = envelope.result as ReasoningResult;
    if (!config.reasoning || !result || typeof result !== 'object') throw new ProcessorFailure('persistence_failed');
    const reparsed = await parseReasoningOutput({
      output: { outcome: result.outcome, claims: result.claims, unresolvedFields: result.unresolvedFields },
      usage: { inputTokens: result.modelRun?.inputTokens, outputTokens: result.modelRun?.outputTokens },
    }, request, config.reasoning);
    if (stableStringify(reparsed) !== stableStringify(result)) throw new ProcessorFailure('persistence_failed');
    return reparsed;
  }

  async function validateGroundingReceipt(value: unknown, expected: GroundingContextRecord): Promise<GroundingContextRecord> {
    const envelope = exactRecord(value, ['record']);
    if (stableStringify(envelope.record) !== stableStringify(expected)) throw new ProcessorFailure('context_insufficient');
    const persisted = await basePorts.groundingContexts.findById('synthetic', expected.context_id);
    if (!persisted || stableStringify(persisted) !== stableStringify(expected)) throw new ProcessorFailure('persistence_failed');
    return expected;
  }

  async function validateProposalReceipt(value: unknown, expected: {
    readonly proposalId: string; readonly contextId: string; readonly candidateId: string; readonly status: 'persisted';
  }): Promise<typeof expected> {
    const envelope = exactRecord(value, ['record']);
    if (stableStringify(envelope.record) !== stableStringify(expected)) throw new ProcessorFailure('persistence_failed');
    return expected;
  }
}

function makeRevisionRecord(
  snapshot: ReportSnapshot,
  permittedText: string,
  permittedTextHash: string,
  normalizationVersion: string,
) {
  const recordJson = {
    schema_version: '2.0',
    trace_id: snapshot.traceId,
    record_type: 'ReportRevision',
    dataset_kind: 'synthetic',
    report_revision_id: snapshot.reportRevisionId,
    source_id: LOCAL_SOURCE_ID,
    canonical_url: snapshot.canonicalUrl,
    source_revision_key: snapshot.sourceRevisionKey,
    content_hash: snapshot.contentHash,
    permitted_text: permittedText,
    permitted_text_hash: permittedTextHash,
    normalization_version: normalizationVersion,
    published_at: snapshot.publishedAt,
    observed_at: snapshot.observedAt,
    retrieved_at: snapshot.capturedAt,
    validity: { valid_from: null, valid_until: null },
    supersedes_id: snapshot.supersedesId,
    revision_status: 'unreviewed',
  };
  return {
    datasetKind: 'synthetic' as const,
    reportRevisionId: snapshot.reportRevisionId,
    traceId: snapshot.traceId,
    sourceId: LOCAL_SOURCE_ID,
    canonicalUrl: snapshot.canonicalUrl,
    sourceRevisionKey: snapshot.sourceRevisionKey,
    contentHash: snapshot.contentHash,
    permittedText,
    permittedTextHash,
    normalizationVersion,
    publishedAt: snapshot.publishedAt,
    observedAt: snapshot.observedAt,
    retrievedAt: snapshot.capturedAt,
    validFrom: null,
    validUntil: null,
    supersedesId: snapshot.supersedesId,
    revisionStatus: 'unreviewed' as const,
    recordJson,
  };
}

async function persistOrigin(tx: TransactionalSqlExecutor, snapshot: ReportSnapshot, originId: string): Promise<void> {
  const record = {
    schema_version: '2.0',
    record_type: 'EvidenceOrigin',
    dataset_kind: 'synthetic',
    origin_id: originId,
    report_revision_id: snapshot.reportRevisionId,
    origin_kind: 'unknown',
    lineage_relation: 'unknown',
    independence_status: 'unknown',
  };
  await tx.query(
    `INSERT INTO waspada.evidence_origins
       (dataset_kind, origin_id, trace_id, origin_kind, source_id, lineage_relation, independence_status, record_json)
     VALUES ('synthetic', $1, $2, 'unknown', $3, 'unknown', 'unknown', $4::jsonb)
     ON CONFLICT (dataset_kind, origin_id) DO NOTHING`,
    [originId, snapshot.traceId, LOCAL_SOURCE_ID, JSON.stringify(record)],
  );
  const existing = await tx.query<{ trace_id: string; source_id: string | null; independence_status: string; lineage_relation: string }>(
    `SELECT trace_id, source_id, independence_status, lineage_relation
     FROM waspada.evidence_origins WHERE dataset_kind = 'synthetic' AND origin_id = $1`, [originId],
  );
  const row = existing.rows[0];
  if (!row || row.trace_id !== snapshot.traceId || row.source_id !== LOCAL_SOURCE_ID
    || row.independence_status !== 'unknown' || row.lineage_relation !== 'unknown') {
    throw new ProcessorFailure('persistence_failed');
  }
  await tx.query(
    `INSERT INTO waspada.origin_report_revisions (dataset_kind, origin_id, report_revision_id)
     VALUES ('synthetic', $1, $2) ON CONFLICT (dataset_kind, origin_id, report_revision_id) DO NOTHING`,
    [originId, snapshot.reportRevisionId],
  );
}

async function persistOriginEvidence(tx: TransactionalSqlExecutor, originId: string, evidenceReferenceId: string): Promise<void> {
  await tx.query(
    `INSERT INTO waspada.origin_evidence (dataset_kind, origin_id, evidence_ref_id)
     VALUES ('synthetic', $1, $2::bigint)
     ON CONFLICT (dataset_kind, origin_id, evidence_ref_id) DO NOTHING`,
    [originId, evidenceReferenceId],
  );
}

function toExtractionRecord(result: ExtractionResult, snapshot: ReportSnapshot): ExtractionResultRecord {
  return {
    schema_version: '2.0',
    trace_id: snapshot.traceId,
    record_type: 'ExtractionResult',
    dataset_kind: 'synthetic',
    candidate_id: snapshot.candidateId,
    report_revision_id: snapshot.reportRevisionId,
    category: result.category,
    tags: result.tags.map((tag) => ({ namespace: tag.namespace, value: tag.value })),
    event_time: { start: result.eventTime.start, end: result.eventTime.end, precision: result.eventTime.precision },
    scope: {
      place_ids: [...result.scope.placeIds],
      service_ids: [...result.scope.serviceIds],
      institution_ids: [...result.scope.institutionIds],
      audience_ids: [...result.scope.audienceIds],
      geometry_ids: [...result.scope.geometryIds],
    },
    evidence: result.evidence.map((reference) => ({
      report_revision_id: reference.reportRevisionId,
      permitted_text_hash: reference.permittedTextHash,
      span_start: reference.spanStart,
      span_end: reference.spanEnd,
      offset_unit: reference.offsetUnit,
      relation: reference.relation,
    })),
    unknown_fields: [...result.unknownFields],
    model_run: {
      capability: 'extraction',
      model_version: result.modelRun.modelVersion,
      prompt_version: result.modelRun.promptVersion,
      input_tokens: result.modelRun.inputTokens,
      output_tokens: result.modelRun.outputTokens,
    },
  };
}

function toEmbeddingRecord(result: EmbeddingResult, snapshot: ReportSnapshot): EmbeddingRunRecord {
  return {
    schema_version: '2.0',
    trace_id: snapshot.traceId,
    record_type: 'EmbeddingRun',
    dataset_kind: 'synthetic',
    embedding_run_id: `embedding-${hash(JSON.stringify([result.chunkId, result.provider, result.modelVersion, result.vectorIndexVersion])).slice(0, 48)}`,
    chunk_id: result.chunkId,
    capability: 'embedding',
    provider: result.provider,
    model_version: result.modelVersion,
    dimensions: result.dimensions,
    distance_metric: result.distanceMetric,
    vector_index_version: result.vectorIndexVersion,
    input_text_hash: result.inputTextHash,
    status: 'available',
    created_at: snapshot.capturedAt,
  };
}

function requiredEmbeddingIdentity(configuration: ModelAdapterConfiguration) {
  if (!configuration.embedding) throw new ProcessorFailure('model_failed');
  return configuration.embedding;
}

function requireCapability<T, C extends 'extraction' | 'embedding' | 'reasoning'>(
  outcome: { readonly status: string; readonly capability: string; readonly value?: T },
  capability: C,
): T {
  if (outcome.capability !== capability) throw new ProcessorFailure('invalid_output');
  if (outcome.status === 'succeeded' && outcome.value !== undefined) return outcome.value;
  if (outcome.status === 'invalid_output' || outcome.status === 'invalid_request') {
    throw new ProcessorFailure('invalid_output');
  }
  throw new ProcessorFailure('model_failed');
}

function createAiLeaseGuard(options: {
  readonly job: AiJob;
  readonly store: LocalPipelineStore;
  readonly now: () => string;
  readonly signal?: AbortSignal;
  readonly cancel?: () => void;
  readonly renew: boolean;
  readonly renewIntervalMs: number;
}): AiLeaseGuard {
  const { job, store, now, signal, cancel, renew, renewIntervalMs } = options;
  const leaseStore = store as LeaseRenewingStore;
  let stopped = false;
  let leaseLost = false;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewalTask: Promise<void> | undefined;
  let lane: Promise<void> = Promise.resolve();
  let signalListener: (() => void) | undefined;
  let cancelInvoked = false;
  let interrupt!: (failure: LeaseControlFailure) => void;
  const interrupted = new Promise<LeaseControlFailure>((resolve) => { interrupt = resolve; });

  const cancelTransport = () => {
    if (cancelInvoked || !cancel) return;
    cancelInvoked = true;
    try { cancel(); } catch { /* Transport cancellation is best effort. */ }
  };

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const markCancelled = () => {
    if (leaseLost || cancelled) return;
    cancelled = true;
    clearTimer();
    cancelTransport();
    interrupt(new LeaseControlFailure('cancelled'));
  };

  const markLeaseLost = () => {
    if (leaseLost) return;
    leaseLost = true;
    clearTimer();
    cancelTransport();
    interrupt(new LeaseControlFailure('lease_lost'));
  };

  const assertActive = () => {
    if (!leaseLost && !cancelled && signal?.aborted) markCancelled();
    if (leaseLost) throw new LeaseControlFailure('lease_lost');
    if (cancelled) throw new LeaseControlFailure('cancelled');
  };

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = lane.then(operation);
    lane = result.then(() => undefined, () => undefined);
    return result;
  };

  const runFenced = <T>(operation: () => Promise<T>): Promise<T> => serialize(async () => {
    assertActive();
    return await operation();
  });

  const runRelease = <T>(operation: () => Promise<T>): Promise<T> => serialize(async () => {
    if (leaseLost) throw new LeaseControlFailure('lease_lost');
    return await operation();
  });

  const scheduleRenewal = () => {
    if (!renew || stopped || leaseLost || cancelled) return;
    timer = setTimeout(() => {
      timer = undefined;
      const task = serialize(async () => {
        if (stopped || leaseLost || cancelled) return;
        try {
          assertActive();
          const renewed = await leaseStore.renewAi(job, now(), JOB_QUEUE_POLICY.maxLeaseDurationMs);
          if (!renewed) markLeaseLost();
        } catch {
          // A failed renewal leaves ownership uncertain, so this attempt fails closed.
          markLeaseLost();
        }
      }).then(() => undefined, () => { markLeaseLost(); });
      renewalTask = task;
      void task.then(() => {
        if (renewalTask === task) renewalTask = undefined;
        scheduleRenewal();
      });
    }, renewIntervalMs);
  };

  if (signal) {
    signalListener = () => markCancelled();
    signal.addEventListener('abort', signalListener, { once: true });
    if (signal.aborted) markCancelled();
  }
  scheduleRenewal();

  return {
    get leaseLost() { return leaseLost; },
    assertActive,
    markLeaseLost,
    runFenced,
    runRelease,
    async runModel<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
      assertActive();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const work = Promise.resolve().then(() => {
        assertActive();
        return operation();
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          cancelTransport();
          reject(new ModelTimeout());
        }, timeoutMs);
      });
      try {
        return await Promise.race([
          work,
          timeoutPromise,
          interrupted.then((failure) => { throw failure; }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
    async stop(): Promise<void> {
      stopped = true;
      clearTimer();
      if (signal && signalListener) signal.removeEventListener('abort', signalListener);
      const pending = renewalTask;
      if (pending) await pending;
    },
  };
}

function joinTransaction(transaction: SqlExecutor): TransactionalSqlExecutor {
  return {
    query: transaction.query.bind(transaction),
    execute: transaction.execute.bind(transaction),
    transaction: async <Result>(work: (tx: SqlExecutor) => Promise<Result>) => await work(transaction),
  };
}

function originIdFor(snapshot: ReportSnapshot): string {
  return `origin-${hash(snapshot.reportRevisionId).slice(0, 40)}`;
}

function snapshotIdentity(snapshot: ReportSnapshot): string {
  return hash(stableStringify(snapshot));
}

function sameSnapshotIdentity(left: ReportSnapshot, right: ReportSnapshot): boolean {
  return snapshotIdentity(left) === snapshotIdentity(right);
}

function exactRecord(value: unknown, fields: readonly string[]): Record<string, any> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ProcessorFailure('persistence_failed');
  const record = value as Record<string, any>;
  const keys = Object.keys(record);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) throw new ProcessorFailure('persistence_failed');
  return record;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? '"undefined"';
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
