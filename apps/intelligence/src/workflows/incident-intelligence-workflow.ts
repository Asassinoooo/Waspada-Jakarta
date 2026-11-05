import { z } from "zod";
import { createWorkflow, createStep } from "@mastra/core/workflows";
import type { SqlExecutor, TransactionalSqlExecutor } from "../../../db/src/sql.js";
import type { DatasetKind } from "../../../db/src/ports.js";
import {
  createSqlIncidentRepository,
  type IncidentRecord,
  type IncidentRelationship,
  type CorrelationDecision,
  type PersistIncidentProcessingInput,
} from "../../../db/src/incident-repository.js";
import {
  createEventProposalWriter,
  type EventProposalDto,
} from "../../../db/src/event-proposal-writer.js";
import {
  ReportInterpretationSchema,
  interpretReport,
  type ReportInterpretation,
} from "../agents/report-interpretation-agent.js";
import {
  IncidentCorrelationSchema,
  correlateIncident,
  type IncidentCorrelation,
} from "../agents/incident-correlation-agent.js";
import { createSemanticRetrievalService, type CandidateIncidentMatch } from "../services/semantic-retrieval-service.js";
import type { NineRouterConfig } from "../providers/ninerouter-adapter.js";
import { Agent } from "@mastra/core/agent";

export const WorkflowChunkSchema = z.object({
  chunkId: z.string(),
  spanStart: z.number(),
  spanEnd: z.number(),
  text: z.string(),
});

export const IncidentWorkflowInputSchema = z.object({
  jobId: z.string().optional(),
  leaseToken: z.string().optional(),
  reportRevisionId: z.string(),
  reportText: z.string(),
  sourceKind: z.string(),
  sourceDisplayName: z.string(),
  /** WJ-INT-02B: registry source id for the public-display rights gate. */
  sourceId: z.string().optional(),
  publishedAt: z.string().nullable().optional(),
  datasetKind: z.enum(["live", "historical", "synthetic"]),
  traceId: z.string(),
  evidenceChunks: z.array(WorkflowChunkSchema),
  triage: z.object({
    disposition: z.enum(["ingest"]),
    primaryCategory: z.string().nullable(),
    incidentType: z.string().nullable(),
    jakartaScope: z.string(),
    actionability: z.string(),
    confidence: z.string(),
    itemIdentityHash: z.string().optional(),
  }).optional(),
});

export interface IncidentWorkflowOutput {
  readonly reportRevisionId: string;
  readonly interpretation: ReportInterpretation;
  readonly correlation: IncidentCorrelation;
  readonly incident: IncidentRecord;
  readonly proposal: EventProposalDto | null;
}

export function deriveCompatibilityCategory(
  incidentType: string,
): "flood" | "fire" | "accident" | "tree_fall" | "crime" | "weather" | "unclassified" {
  const lower = incidentType.toLowerCase();
  if (lower.includes("banjir") || lower.includes("genang") || lower.includes("air") || lower.includes("luapan")) {
    return "flood";
  }
  if (lower.includes("kebakaran") || lower.includes("api") || lower.includes("hangus")) {
    return "fire";
  }
  if (lower.includes("tabrakan") || lower.includes("kecelakaan") || lower.includes("truk") || lower.includes("motor") || lower.includes("mobil")) {
    return "accident";
  }
  if (lower.includes("pohon") || lower.includes("tumbang") || lower.includes("ranting")) {
    return "tree_fall";
  }
  if (lower.includes("begal") || lower.includes("curi") || lower.includes("tawuran") || lower.includes("rampok") || lower.includes("kriminal")) {
    return "crime";
  }
  if (lower.includes("cuaca") || lower.includes("badai") || lower.includes("angin") || lower.includes("hujan")) {
    return "weather";
  }
  return "unclassified";
}


export function createIncidentIntelligenceWorkflow(dependencies: {
  readonly executor: SqlExecutor;
  readonly transactionalExecutor?: TransactionalSqlExecutor;
  readonly config?: NineRouterConfig;
  readonly agentOverrides?: {
    readonly interpreter?: Agent;
    readonly correlator?: Agent;
  };
}) {
  const retrievalService = createSemanticRetrievalService({
    executor: dependencies.executor,
    transactionalExecutor: dependencies.transactionalExecutor,
    config: dependencies.config,
  });

  const incidentRepo = createSqlIncidentRepository(dependencies.executor);
  const proposalWriter = createEventProposalWriter(dependencies.executor);

  // Step 1: Interpret Report
  const interpretStep = createStep({
    id: "interpret-report",
    inputSchema: IncidentWorkflowInputSchema,
    outputSchema: z.object({
      input: IncidentWorkflowInputSchema,
      interpretation: ReportInterpretationSchema,
    }),
    execute: async ({ inputData }) => {
      const interpretation = await interpretReport(
        {
          reportRevisionId: inputData.reportRevisionId,
          reportText: inputData.reportText,
          sourceKind: inputData.sourceKind,
          sourceDisplayName: inputData.sourceDisplayName,
          publishedAt: inputData.publishedAt,
          evidenceChunks: inputData.evidenceChunks,
        },
        {
          agent: dependencies.agentOverrides?.interpreter,
        },
      );

      return {
        input: inputData,
        interpretation,
      };
    },
  });

  // Step 2: Embed Chunks and Retrieve Candidates
  const retrieveStep = createStep({
    id: "embed-and-retrieve",
    inputSchema: z.object({
      input: IncidentWorkflowInputSchema,
      interpretation: ReportInterpretationSchema,
    }),
    outputSchema: z.object({
      input: IncidentWorkflowInputSchema,
      interpretation: ReportInterpretationSchema,
      candidateIncidents: z.array(z.record(z.unknown())),
    }),
    execute: async ({ inputData }) => {
      // Generate and persist chunk embeddings
      for (const chunk of inputData.input.evidenceChunks) {
        await retrievalService.generateAndPersistEmbedding({
          traceId: inputData.input.traceId,
          datasetKind: inputData.input.datasetKind,
          chunkId: chunk.chunkId,
          chunkText: chunk.text,
        });
      }

      // Query candidates using summary and incident type
      const queryText = `${inputData.interpretation.summary} ${inputData.interpretation.incidentType} ${inputData.interpretation.location.label ?? ""}`.trim();
      const retrievalResult = await retrievalService.retrieveCandidates({
        datasetKind: inputData.input.datasetKind,
        queryText,
        maxResults: 5,
      });

      return {
        input: inputData.input,
        interpretation: inputData.interpretation,
        candidateIncidents: retrievalResult.candidateIncidents as unknown as Array<Record<string, unknown>>,
      };
    },
  });

  // Step 3: Correlate Incident
  const correlateStep = createStep({
    id: "correlate-incident",
    inputSchema: z.object({
      input: IncidentWorkflowInputSchema,
      interpretation: ReportInterpretationSchema,
      candidateIncidents: z.array(z.record(z.unknown())),
    }),
    outputSchema: z.object({
      input: IncidentWorkflowInputSchema,
      interpretation: ReportInterpretationSchema,
      correlation: IncidentCorrelationSchema,
    }),
    execute: async ({ inputData }) => {
      const correlation = await correlateIncident(
        {
          incomingReportRevisionId: inputData.input.reportRevisionId,
          incomingReportText: inputData.input.reportText,
          incomingInterpretation: inputData.interpretation,
          candidateIncidents: inputData.candidateIncidents as unknown as readonly CandidateIncidentMatch[],
        },
        {
          agent: dependencies.agentOverrides?.correlator,
        },
      );

      return {
        input: inputData.input,
        interpretation: inputData.interpretation,
        correlation,
      };
    },
  });

  // Step 4: Persist Incident & Grounded Proposal
  const persistStep = createStep({
    id: "persist-and-propose",
    inputSchema: z.object({
      input: IncidentWorkflowInputSchema,
      interpretation: ReportInterpretationSchema,
      correlation: IncidentCorrelationSchema,
    }),
    outputSchema: z.object({
      reportRevisionId: z.string(),
      interpretation: ReportInterpretationSchema,
      correlation: IncidentCorrelationSchema,
      incident: z.record(z.unknown()),
      proposal: z.record(z.unknown()).nullable(),
    }),
    execute: async ({ inputData }) => {
      const { input, interpretation, correlation } = inputData;
      const now = new Date().toISOString();
      const datasetKind = input.datasetKind as DatasetKind;

      const decisionId = `dec-${input.reportRevisionId}`;
      // WJ-INT-02B: triage category is authoritative for RSS reports (input
      // carries it only on the gated path). The interpreter's independent
      // value is preserved for comparison; mismatches are flagged, never
      // silently resolved. Structured sources (no input.triage) keep
      // interpreter authorship exactly as before.
      const triageLineage = input.triage
        ? {
            primaryCategory: input.triage.primaryCategory,
            jakartaScope: input.triage.jakartaScope,
            disposition: input.triage.disposition,
            itemIdentityHash: input.triage.itemIdentityHash ?? null,
          }
        : null;
      const triageCategory = input.triage?.primaryCategory ?? null;
      const triageMismatch =
        triageCategory !== null && triageCategory !== interpretation.primaryCategory;
      // Triage upstream guarantees a canonical slug on ingest; the interpreter
      // schema guarantees its own value. Structured path uses interpretation.
      const authoritativeCategory = (triageCategory ?? interpretation.primaryCategory) as ReportInterpretation["primaryCategory"];
      const interpretationLineage = input.triage
        ? {
            primaryCategory: interpretation.primaryCategory,
            incidentType: interpretation.incidentType,
            confidence: interpretation.confidence,
          }
        : null;
      let incidentAction: PersistIncidentProcessingInput["incidentAction"];
      let targetIncidentId: string;
      let relationship: IncidentRelationship;
      if (correlation.decision === "same_incident" && correlation.candidateIncidentId) {
        relationship = "corroborating";
        targetIncidentId = correlation.candidateIncidentId;
        const existing = await incidentRepo.getIncidentById(datasetKind, correlation.candidateIncidentId);
        const resolvedSeverity = interpretation.severity !== "unknown"
          ? interpretation.severity
          : (existing?.incident.severity ?? "unknown");

        const mergedDiscrepancies = [
          ...(existing?.incident.discrepancies ?? []),
          ...correlation.contradictoryEvidence,
        ];
        const mergedUncertainties = Array.from(
          new Set([...(existing?.incident.uncertaintyNotes ?? []), ...interpretation.uncertaintyNotes]),
        );

        incidentAction = {
          type: "update",
          incident: {
            incidentId: targetIncidentId,
            datasetKind,
            lastUpdatedAt: now,
            primaryCategory: authoritativeCategory,
            discrepancies: mergedDiscrepancies,
            uncertaintyNotes: mergedUncertainties,
            severity: resolvedSeverity,
          },
        };
      } else if (correlation.decision === "unresolved" && correlation.candidateIncidentId) {
        relationship = "unresolved";
        targetIncidentId = correlation.candidateIncidentId;
        incidentAction = {
          type: "update",
          incident: {
            incidentId: targetIncidentId,
            datasetKind,
            lastUpdatedAt: now,
            primaryCategory: authoritativeCategory,
          },
        };
      } else {
        relationship = correlation.decision === "unresolved" ? "unresolved" : "primary_initial";
        targetIncidentId = `inc-${input.reportRevisionId}`;
        const initialStatus = (correlation.decision === "unresolved" || interpretation.confidence === "low")
          ? "investigating"
          : "active";

        incidentAction = {
          type: "create",
          incident: {
            incidentId: targetIncidentId,
            datasetKind,
            title: interpretation.summary.slice(0, 150),
            description: interpretation.summary,
            incidentType: interpretation.incidentType,
            primaryCategory: authoritativeCategory,
            status: initialStatus,
            severity: interpretation.severity ?? "unknown",
            locationLabel: interpretation.location.label,
            coordinates: interpretation.location.approximateCoordinates,
            firstObservedAt: interpretation.eventTime.value ?? input.publishedAt ?? now,
            uncertaintyNotes: [
              ...interpretation.uncertaintyNotes,
              ...(correlation.decision === "unresolved" ? correlation.unresolvedQuestions : []),
            ],
            recordJson: {
              impacts: interpretation.impacts,
              confidence: interpretation.confidence,
              ...(triageLineage ? { triage: triageLineage } : {}),
              ...(interpretationLineage ? { interpretation: interpretationLineage } : {}),
              ...(triageMismatch ? { triage_mismatch: true } : {}),
            },
            createdAt: now,
          },
        };
      }

      // Generate grounded proposal for moderation queue
      const compatibilityCat = deriveCompatibilityCategory(interpretation.incidentType);

      const claims: Array<EventProposalDto["claims"][number]> = interpretation.evidence.map((ev, idx) => ({
        claim_id: `claim-${idx + 1}`,
        claim_text: ev.supports,
        evidence_label: "under_review",
        support_assessment: "supported",
        quote_text: ev.exactQuote,
        evidence_ref_id: ev.chunkId,
      }));

      if (claims.length === 0) {
        claims.push({
          claim_id: "claim-1",
          claim_text: interpretation.summary,
          evidence_label: "under_review",
          support_assessment: "uncertain",
          quote_text: "",
          evidence_ref_id: input.evidenceChunks[0]?.chunkId || "chunk-unverified",
        });
      }

      let proposalId = `prop-${targetIncidentId}`;
      let isMultiSource = false;
      let sourceCount = 1;
      let proposalClaims = claims;
      let proposalDiscrepancies: unknown[] = [];
      let hasDiscrepancy = false;
      let proposalCaveats = triageMismatch
        ? [...interpretation.uncertaintyNotes, "category_mismatch_review"]
        : [...interpretation.uncertaintyNotes];

      if (correlation.decision === "same_incident" && correlation.candidateIncidentId) {
        const existingProposalRow = await dependencies.executor.query<{ proposal_id: string; record_json: unknown }>(
          `SELECT ep.proposal_id, ep.record_json
           FROM waspada.event_proposals ep
           WHERE ep.dataset_kind = $1 AND (
             ep.proposal_id = $2
             OR ep.proposal_id IN (
               SELECT ipr.proposal_id
               FROM waspada.incident_processing_records ipr
               WHERE ipr.dataset_kind = $1 AND ipr.incident_id = $3
             )
           )
           ORDER BY (ep.proposal_id = $2) DESC
           LIMIT 1`,
          [datasetKind, `prop-${correlation.candidateIncidentId}`, correlation.candidateIncidentId],
        );

        if (existingProposalRow.rows.length > 0) {
          const rawExisting = existingProposalRow.rows[0]!.record_json;
          const existing = (typeof rawExisting === "string" ? JSON.parse(rawExisting) : rawExisting) as EventProposalDto;
          sourceCount = Math.max(2, (existing.source_count ?? 1) + 1);
          proposalId = `prop-${correlation.candidateIncidentId}-v${sourceCount}`;
          isMultiSource = true;

          const updatedExistingClaims = (existing.claims ?? []).map((c) => ({
            ...c,
            is_corroborated: true,
          }));

          const newCorroboratedClaims = claims.map((c, idx) => ({
            ...c,
            claim_id: `claim-${updatedExistingClaims.length + idx + 1}`,
            is_corroborated: true,
          }));

          proposalClaims = [...updatedExistingClaims, ...newCorroboratedClaims];

          const mappedDiscrepancies = (correlation.contradictoryEvidence ?? []).map((diff) => ({
            kind: diff.field || "general_conflict",
            description: `Perbedaan ${diff.field}: "${diff.claimA}" vs "${diff.claimB}"`,
            source_a: {
              source_id: (existing as any).source_id ?? "sumber_sebelumnya",
              claim_text: diff.claimA,
            },
            source_b: {
              source_id: input.sourceDisplayName ?? input.sourceId ?? "sumber_baru",
              claim_text: diff.claimB,
            },
          }));

          proposalDiscrepancies = [
            ...((existing.discrepancies as any[]) ?? []),
            ...mappedDiscrepancies,
          ];
          hasDiscrepancy = proposalDiscrepancies.length > 0;

          proposalCaveats = Array.from(new Set([
            ...((existing.caveats as string[]) ?? []),
            ...proposalCaveats,
          ]));
        } else {
          isMultiSource = true;
          sourceCount = 2;
          proposalId = `prop-${correlation.candidateIncidentId}-v2`;
          proposalClaims = claims.map((c) => ({ ...c, is_corroborated: true }));
        }
      }

      const proposalDto: EventProposalDto = {
        schema_version: "2.0",
        proposal_id: proposalId,
        incident_id: targetIncidentId,
        title: interpretation.summary.slice(0, 120),
        incident_type: interpretation.incidentType,
        primary_category: authoritativeCategory,
        compatibility_category: compatibilityCat,
        severity: interpretation.severity ?? "unknown",
        event_time: {
          precision: interpretation.eventTime.precision,
          value: interpretation.eventTime.value,
        },
        location_label: interpretation.location.label,
        coordinates: interpretation.location.approximateCoordinates,
        claims: proposalClaims,
        impacts: interpretation.impacts,
        // WJ-INT-02B: interpreter's independent value for accept_interpretation.
        interpretation_category: input.triage ? interpretation.primaryCategory : null,
        // WJ-INT-02B: registry source id for the public-display rights gate.
        source_id: input.sourceId ?? null,
        is_multi_source: isMultiSource,
        source_count: sourceCount,
        has_discrepancy: hasDiscrepancy,
        discrepancies: proposalDiscrepancies,
        caveats: proposalCaveats,
        proposed_at: now,
      };
      let resolvedIncident: IncidentRecord | Record<string, unknown>;
      if (input.jobId && input.leaseToken) {
        await incidentRepo.persistIncidentProcessingTransaction({
          jobId: input.jobId,
          leaseToken: input.leaseToken,
          datasetKind,
          reportRevisionId: input.reportRevisionId,
          pipelineVersion: "v1",
          incidentAction,
          correlationDecision: {
            decisionId,
            datasetKind,
            reportRevisionId: input.reportRevisionId,
            decision: correlation.decision as CorrelationDecision,
            targetIncidentId,
            reasoning: correlation.reasoning,
            evidenceQuotes: correlation.supportingEvidence,
            conflicts: correlation.contradictoryEvidence,
            uncertainty: correlation.uncertainty,
            createdAt: now,
          },
          reportLink: {
            relationship,
          },
          proposal: proposalDto,
          proposalAction: correlation.decision === "same_incident" ? "upsert" : "create",
          now,
        });
        const loaded = await incidentRepo.getIncidentById(datasetKind, targetIncidentId);
        resolvedIncident = (loaded?.incident ?? incidentAction.incident) as unknown as Record<string, unknown>;
      } else {
        if (incidentAction.type === "create") {
          resolvedIncident = await incidentRepo.createIncident(incidentAction.incident);
        } else {
          resolvedIncident = await incidentRepo.updateIncident(incidentAction.incident);
        }
        await incidentRepo.recordCorrelationDecision({
          decisionId,
          datasetKind,
          reportRevisionId: input.reportRevisionId,
          decision: correlation.decision as CorrelationDecision,
          targetIncidentId,
          reasoning: correlation.reasoning,
          evidenceQuotes: correlation.supportingEvidence,
          conflicts: correlation.contradictoryEvidence,
          uncertainty: correlation.uncertainty,
          createdAt: now,
        });
        await incidentRepo.linkReport({
          datasetKind,
          incidentId: targetIncidentId,
          reportRevisionId: input.reportRevisionId,
          relationship,
          correlationDecisionId: decisionId,
          linkedAt: now,
        });
        await proposalWriter.persistProposal(proposalDto, datasetKind, {
          upsert: correlation.decision === "same_incident",
        });
      }

      return {
        reportRevisionId: input.reportRevisionId,
        interpretation,
        correlation,
        incident: resolvedIncident as Record<string, unknown>,
        proposal: proposalDto as unknown as Record<string, unknown>,
      };
    },
  });

  return createWorkflow({
    id: "incident-intelligence-workflow",
    inputSchema: IncidentWorkflowInputSchema,
    outputSchema: z.object({
      reportRevisionId: z.string(),
      interpretation: ReportInterpretationSchema,
      correlation: IncidentCorrelationSchema,
      incident: z.record(z.unknown()),
      proposal: z.record(z.unknown()).nullable(),
    }),
  })
    .then(interpretStep)
    .then(retrieveStep)
    .then(correlateStep)
    .then(persistStep)
    .commit();
}
