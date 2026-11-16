// HOSTED-20: agent errors carry fixed codes only. Mastra logs a failed step's message, so a message that holds a
// quote or model answer would reach the public Actions log. No network, no database.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
  CorrelationValidationError,
  EvidenceProvenanceError,
  IncidentCorrelationSchema,
  validateCorrelationDecision,
  type CorrelateIncidentInput,
  type IncidentCorrelation,
} from "../src/agents/incident-correlation-agent.js";
import { ModelOutputError, parseModelOutput } from "../src/agents/model-output.js";
import { classifyJobError } from "../src/job-runner.js";

const MARKER = "SECRET-QUOTE-7f3a";

// validateCorrelationDecision reads only the revision ID, the report text and the candidates.
const input = {
  incomingReportRevisionId: "rev-incoming-001",
  incomingReportText: "Banjir setinggi 60cm merendam Jalan Rasuna Said depan Kemenkes pada pukul 14.30.",
  incomingInterpretation: {},
  candidateIncidents: [],
} as unknown as CorrelateIncidentInput;

function correlation(overrides: Partial<IncidentCorrelation>): IncidentCorrelation {
  return {
    decision: "new_incident",
    candidateIncidentId: null,
    reasoning: "test",
    supportingEvidence: [],
    contradictoryEvidence: [],
    distinctions: [],
    unresolvedQuestions: [],
    uncertainty: [],
    has_discrepancy: false,
    discrepancy_summary: null,
    ...overrides,
  };
}

/** The message, the stack and the full inspected form must all be free of the marker. */
function assertNoMarker(error: unknown): void {
  const err = error as Error;
  assert.equal(err.message.includes(MARKER), false, "message carries model text");
  assert.equal((err.stack ?? "").includes(MARKER), false, "stack carries model text");
  assert.equal(inspect(err, { showHidden: true, depth: 5 }).includes(MARKER), false, "inspect carries model text");
}

describe("EvidenceProvenanceError carries a fixed code", () => {
  it("drops a fabricated quote from the message", () => {
    const decision = correlation({
      decision: "new_incident",
      supportingEvidence: [{ reportRevisionId: "rev-incoming-001", quote: MARKER, relevance: "fabricated" }],
    });
    assert.throws(
      () => validateCorrelationDecision(decision, input),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceProvenanceError);
        assert.equal(error.message, "evidence_quote_not_in_incoming_report");
        assertNoMarker(error);
        return true;
      },
    );
  });

  it("drops a model-supplied revision ID from the message", () => {
    const decision = correlation({
      decision: "new_incident",
      supportingEvidence: [{ reportRevisionId: `rev-${MARKER}`, quote: "Banjir", relevance: "unknown report" }],
    });
    assert.throws(
      () => validateCorrelationDecision(decision, input),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceProvenanceError);
        assert.equal(error.message, "evidence_report_revision_unknown");
        assertNoMarker(error);
        return true;
      },
    );
  });
});

describe("CorrelationValidationError carries a fixed code", () => {
  it("does not echo a model-supplied candidate ID", () => {
    const decision = correlation({ decision: "same_incident", candidateIncidentId: `inc-${MARKER}` });
    assert.throws(
      () => validateCorrelationDecision(decision, input),
      (error: unknown) => {
        assert.ok(error instanceof CorrelationValidationError);
        assert.equal(error.message, "candidate_incident_unknown");
        assertNoMarker(error);
        return true;
      },
    );
  });

  it("keeps the new_incident and same_incident messages free of model text", () => {
    const newWithCandidate = correlation({ decision: "new_incident", candidateIncidentId: `inc-${MARKER}` });
    assert.throws(
      () => validateCorrelationDecision(newWithCandidate, input),
      (error: unknown) => {
        assert.equal((error as Error).message, "new_incident_candidate_set");
        assertNoMarker(error);
        return true;
      },
    );
    const sameWithoutCandidate = correlation({ decision: "same_incident", candidateIncidentId: null });
    assert.throws(
      () => validateCorrelationDecision(sameWithoutCandidate, input),
      (error: unknown) => {
        assert.equal((error as Error).message, "same_incident_candidate_missing");
        return true;
      },
    );
  });
});

describe("parseModelOutput never carries the answer", () => {
  it("drops the JSON syntax error text, which quotes the input", () => {
    const answer = `not json ${MARKER} "quoted source text"`;
    assert.throws(
      () => parseModelOutput(answer, IncidentCorrelationSchema),
      (error: unknown) => {
        assert.ok(error instanceof ModelOutputError);
        assert.equal(error.message, "agent_output_json_invalid");
        assertNoMarker(error);
        return true;
      },
    );
  });

  it("drops the schema error text, which can echo a received value", () => {
    const answer = JSON.stringify({
      decision: MARKER,
      candidateIncidentId: null,
      reasoning: "x",
      supportingEvidence: [],
      contradictoryEvidence: [],
      distinctions: [],
      unresolvedQuestions: [],
      uncertainty: [],
      has_discrepancy: false,
      discrepancy_summary: null,
    });
    assert.throws(
      () => parseModelOutput(answer, IncidentCorrelationSchema),
      (error: unknown) => {
        assert.ok(error instanceof ModelOutputError);
        assert.equal(error.message, "agent_output_schema_invalid");
        assertNoMarker(error);
        return true;
      },
    );
  });

  it("returns the parsed value for a valid answer", () => {
    const answer = JSON.stringify({
      decision: "new_incident",
      candidateIncidentId: null,
      reasoning: "Lokasi jelas.",
      supportingEvidence: [],
      contradictoryEvidence: [],
      distinctions: [],
      unresolvedQuestions: [],
      uncertainty: [],
      has_discrepancy: false,
      discrepancy_summary: null,
    });
    const parsed = parseModelOutput(`\`\`\`json\n${answer}\n\`\`\``, IncidentCorrelationSchema);
    assert.equal(parsed.decision, "new_incident");
  });
});

describe("failure classes are unchanged for the new codes", () => {
  it("keeps JSON and schema failures as invalid_output", () => {
    assert.equal(classifyJobError(new ModelOutputError("agent_output_json_invalid")), "invalid_output");
    assert.equal(classifyJobError(new ModelOutputError("agent_output_schema_invalid")), "invalid_output");
  });

  it("keeps provenance failures as workflow_execution_failed", () => {
    assert.equal(
      classifyJobError(new EvidenceProvenanceError("evidence_quote_not_in_incoming_report")),
      "workflow_execution_failed",
    );
  });
});
