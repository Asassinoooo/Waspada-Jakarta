/**
 * Schema 2.0 event proposal shapes shared by the L1 webhook ingest path and the
 * L2 proposal engines (F-03). Type-only: this module has no runtime code.
 *
 * The L2 proposal engine re-exports these names from `proposal-engine.ts`, so
 * existing importers keep working. L1 depends only on this file, never on L2.
 */

import type { IncidentCategory } from "./multisource-correlator.js";

export type IncidentSeverity = "low" | "medium" | "high" | "critical" | "unknown";

export interface EventProposalClaimDto {
  readonly claim_id: string;
  readonly claim_text: string;
  readonly evidence_label: "under_review";
  readonly support_assessment: "supported";
  readonly quote_text: string;
  readonly evidence_ref_id: string;
}

export interface EventProposalDto {
  readonly schema_version: "2.0";
  readonly proposal_id: string;
  readonly title: string;
  readonly incident_type: IncidentCategory;
  readonly public_category?: string;
  readonly severity: IncidentSeverity;
  readonly event_time: {
    readonly precision: "exact" | "date" | "range" | "unknown";
    readonly value: string | null;
  };
  readonly location_label: string | null;
  readonly coordinates: readonly [longitude: number, latitude: number] | null;
  readonly claims: readonly EventProposalClaimDto[];
  readonly proposed_at: string;
}
