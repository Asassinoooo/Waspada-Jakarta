import type {
  ModelAdapterConfiguration,
  ModelCapabilityAdapter,
  ReasoningRequest,
  EvidenceReference,
  UntrustedModelProvider,
} from '../../apps/worker/src/layers/l2-model-grounding/contracts.js';
import { createModelCapabilityAdapter } from '../../apps/worker/src/layers/l2-model-grounding/adapter.js';

export interface LocalMockModels {
  readonly adapter: ModelCapabilityAdapter;
  readonly configuration: ModelAdapterConfiguration;
  readonly profileId: string;
}

/** Deterministic provider for local tests and demos; it performs no network calls. */
export function createLocalMockModels(): LocalMockModels {
  const configuration: ModelAdapterConfiguration = {
    extraction: {
      provider: 'local_mock',
      modelVersion: 'local-extraction-v1',
      promptVersion: 'local-extraction-prompt-v1',
    },
    embedding: {
      provider: 'local_mock',
      modelVersion: 'local-embedding-v1',
      dimensions: 8,
      distanceMetric: 'cosine',
      vectorIndexVersion: 'local-vector-v1',
    },
    reasoning: {
      provider: 'local_mock',
      modelVersion: 'local-reasoning-v1',
      promptVersion: 'local-reasoning-prompt-v1',
    },
  };

  const provider: UntrustedModelProvider = {
    async classify() {
      return {
        output: { category: 'disasters_weather', evidence: [], unknownFields: [] },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    async extract(request) {
      const report = request.data.report;
      const evidence: EvidenceReference[] = [{
        reportRevisionId: report.reportRevisionId,
        permittedTextHash: report.permittedTextHash,
        spanStart: 0,
        spanEnd: Array.from(report.permittedText).length,
        offsetUnit: 'unicode_code_points',
        relation: 'supports',
      }];
      const contraryText = 'Catatan latihan terpisah menyebut ruas yang sama tetap dapat dilalui tanpa genangan';
      const contraryIndex = report.permittedText.indexOf(contraryText);
      if (contraryIndex >= 0) {
        const spanStart = Array.from(report.permittedText.slice(0, contraryIndex)).length;
        evidence.push({
          reportRevisionId: report.reportRevisionId,
          permittedTextHash: report.permittedTextHash,
          spanStart,
          spanEnd: spanStart + Array.from(contraryText).length,
          offsetUnit: 'unicode_code_points',
          relation: 'contradicts',
        });
      }
      return {
        output: {
          category: 'disasters_weather',
          tags: [{ namespace: 'hazard', value: 'flooding' }],
          eventTime: { start: null, end: null, precision: 'unknown' },
          scope: { placeIds: [], serviceIds: [], institutionIds: [], audienceIds: [], geometryIds: [] },
          evidence,
          unknownFields: ['event_time'],
        },
        usage: { inputTokens: 48, outputTokens: 32 },
      };
    },
    async embed() {
      return { vector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] };
    },
    async reason(request: ReasoningRequest) {
      const context = request.data.groundingContext;
      const support = context.evidence.find((entry) => entry.reference.relation === 'supports')?.reference;
      const contradictions = context.evidence
        .filter((entry) => entry.reference.relation === 'contradicts')
        .map((entry) => entry.reference);
      if (!support) return { output: { outcome: 'proposed', claims: [], unresolvedFields: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
      return {
        output: {
          outcome: 'proposed',
          claims: [{
            text: 'Laporan latihan sintetis menyebut genangan di sekitar Pasar Minggu.',
            eventTime: { start: null, end: null, precision: 'unknown' },
            validity: { validFrom: null, validUntil: null },
            scope: { placeIds: [], serviceIds: [], institutionIds: [], audienceIds: [], geometryIds: [] },
            qualifiers: ['latihan sintetis'],
            support: [support],
            contradictions,
            contextEvidence: [],
            supportAssessment: 'uncertain',
          }],
          unresolvedFields: [],
        },
        usage: { inputTokens: 96, outputTokens: 42 },
      };
    },
  };

  return {
    adapter: createModelCapabilityAdapter(provider, configuration),
    configuration,
    profileId: 'local-mock-v1',
  };
}
