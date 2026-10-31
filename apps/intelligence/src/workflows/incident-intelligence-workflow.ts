import { z } from "zod";
import { createWorkflow, createStep } from "@mastra/core/workflows";
import type { SqlExecutor, TransactionalSqlExecutor } from "../../../db/src/sql.js";
import type { DatasetKind } from "../../../db/src/ports.js";
import {
  createSqlIncidentRepository,
  type IncidentRecord,
  type IncidentRelationship,
  type CorrelationDecision,
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
  reportRevisionId: z.string(),
  reportText: z.string(),
  sourceKind: z.string(),
  sourceDisplayName: z.string(),
  publishedAt: z.string().nullable().optional(),
  datasetKind: z.enum(["live", "historical", "synthetic"]),
  traceId: z.string(),
  evidenceChunks: z.array(WorkflowChunkSchema),
});

export type IncidentWorkflowInput = z.infer<typeof IncidentWorkflowInputSchema>;

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

      let incident: IncidentRecord;
      let relationship: IncidentRelationship = "primary_initial";

      // 1. Create or update persistent incident
      const decisionId = `dec-${crypto.randomUUID()}`;

      if (correlation.decision === "same_incident" && correlation.candidateIncidentId) {
        relationship = "corroborating";
        const existing = await incidentRepo.getIncidentById(datasetKind, correlation.candidateIncidentId);
        if (existing) {
          const mergedDiscrepancies = [
            ...existing.incident.discrepancies,
            ...correlation.contradictoryEvidence,
          ];
          const mergedUncertainties = Array.from(
            new Set([...existing.incident.uncertaintyNotes, ...interpretation.uncertaintyNotes]),
          );

          const resolvedSeverity = interpretation.severity !== "unknown"
            ? interpretation.severity
            : existing.incident.severity;

          incident = await incidentRepo.updateIncident({
            incidentId: correlation.candidateIncidentId,
            datasetKind,
            lastUpdatedAt: now,
            discrepancies: mergedDiscrepancies,
            uncertaintyNotes: mergedUncertainties,
            severity: resolvedSeverity,
          });
        } else {
          incident = await incidentRepo.createIncident({
            incidentId: `inc-${crypto.randomUUID()}`,
            datasetKind,
            title: interpretation.summary.slice(0, 150),
            description: interpretation.summary,
            incidentType: interpretation.incidentType,
            status: interpretation.confidence === "low" ? "investigating" : "active",
            severity: interpretation.severity ?? "unknown",
            locationLabel: interpretation.location.label,
            coordinates: interpretation.location.approximateCoordinates,
            firstObservedAt: interpretation.eventTime.value ?? input.publishedAt ?? now,
            uncertaintyNotes: interpretation.uncertaintyNotes,
            recordJson: {
              impacts: interpretation.impacts,
              confidence: interpretation.confidence,
            },
            createdAt: now,
          });
        }
      } else {
        relationship = correlation.decision === "unresolved" ? "unresolved" : "primary_initial";
        const initialStatus = (correlation.decision === "unresolved" || interpretation.confidence === "low")
          ? "investigating"
          : "active";

        incident = await incidentRepo.createIncident({
          incidentId: `inc-${crypto.randomUUID()}`,
          datasetKind,
          title: interpretation.summary.slice(0, 150),
          description: interpretation.summary,
          incidentType: interpretation.incidentType,
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
          },
          createdAt: now,
        });
      }

      // 2. Record correlation decision audit trail with resolved target incident ID
      await incidentRepo.recordCorrelationDecision({
        decisionId,
        datasetKind,
        reportRevisionId: input.reportRevisionId,
        decision: correlation.decision as CorrelationDecision,
        targetIncidentId: correlation.candidateIncidentId ?? incident.incidentId,
        reasoning: correlation.reasoning,
        evidenceQuotes: correlation.supportingEvidence,
        conflicts: correlation.contradictoryEvidence,
        uncertainty: correlation.uncertainty,
        createdAt: now,
      });
      // 3. Link report revision to incident
      await incidentRepo.linkReport({
        datasetKind,
        incidentId: incident.incidentId,
        reportRevisionId: input.reportRevisionId,
        relationship,
        correlationDecisionId: decisionId,
        linkedAt: now,
      });

      // 4. Generate grounded proposal for moderation queue
      const proposalId = `prop-${crypto.randomUUID()}`;
      const compatibilityCat = deriveCompatibilityCategory(interpretation.incidentType);

      const claims: Array<EventProposalDto["claims"][number]> = interpretation.evidence.map((ev, idx) => ({
        claim_id: `claim-${idx + 1}`,
        claim_text: ev.supports,
        evidence_label: "under_review",
        support_assessment: "supported",
        quote_text: ev.exactQuote,
        evidence_ref_id: ev.chunkId,
      }));

      // If AI identified no verified evidence quotes from chunks, do not fabricate quote slices
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

      const proposalDto: EventProposalDto = {
        schema_version: "2.0",
        proposal_id: proposalId,
        title: interpretation.summary.slice(0, 120),
        incident_type: interpretation.incidentType,
        compatibility_category: compatibilityCat,
        severity: interpretation.severity ?? "unknown",
        event_time: {
          precision: interpretation.eventTime.precision,
          value: interpretation.eventTime.value,
        },
        location_label: interpretation.location.label,
        coordinates: interpretation.location.approximateCoordinates,
        claims,
        impacts: interpretation.impacts,
        caveats: interpretation.uncertaintyNotes,
        proposed_at: now,
      };
      try {
        await proposalWriter.persistProposal(proposalDto, datasetKind);
      } catch (err) {
        console.error("persistProposal error in workflow:", err);
      }

      return {
        reportRevisionId: input.reportRevisionId,
        interpretation,
        correlation,
        incident: incident as unknown as Record<string, unknown>,
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
