export interface InvestigationRequest {
  caseId: string;
  unresolvedFields: readonly string[];
  priorToolAttempts: number;
}

export interface InvestigationOutcome {
  stopReason: "sufficient_evidence" | "limit_reached" | "needs_review";
  toolAttempts: number;
}

export interface InvestigationCoordinator {
  investigate(request: InvestigationRequest): Promise<InvestigationOutcome>;
}

// No coordinator is configured. Public reads never start an investigation.
