/**
 * Inbound Webhook Ingestion Gateway for Waspada Jakarta.
 *
 * Accepts push events from verified operational channels (e.g. TMC Polda Metro,
 * Dishub DKI, citizen report webhooks) at `POST /api/v1/ingestion/events`.
 * Converts inbound payloads into immutable StoredReportRevision records, runs
 * immediate spatial/temporal correlation, generates Schema 2.0 proposals, and
 * broadcasts them via SSE to moderator command centers.
 */

import { createHash } from "node:crypto";
import { preparePermittedText } from "./text-preparation.js";
import {
  JAKARTA_ENVELOPE,
  generateProposalFromReport,
  type EventProposalDto,
  type StoredReportRevision,
  type StoredEvidenceChunk,
  type IncidentCategory,
  type IncidentSeverity,
} from "../l2-model-grounding/proposal-engine.js";
import { correlateSourceReports } from "./multisource-correlator.js";
import { generateCorrelatedProposal } from "../l2-model-grounding/correlated-proposal-engine.js";
import { eventBroadcaster, EventBroadcaster } from "../l4-application-integration/event-broadcaster.js";

export interface InboundIncidentEvent {
  readonly source_id: string;
  readonly title: string;
  readonly text: string;
  readonly location_hint?: string;
  readonly coordinates?: readonly [number, number];
  readonly timestamp?: string;
  readonly category?: string;
  readonly severity?: "low" | "medium" | "high" | "critical";
  readonly confidence?: number;
}

export interface WebhookIngestOptions {
  readonly broadcaster?: EventBroadcaster;
  readonly activeReports?:
    | readonly StoredReportRevision[]
    | (() => readonly StoredReportRevision[] | Promise<readonly StoredReportRevision[]>);
  readonly onRevisionCreated?: (
    revision: StoredReportRevision,
  ) => void | Promise<void>;
  readonly onProposalCreated?: (
    proposal: EventProposalDto,
    chunks: readonly StoredEvidenceChunk[],
  ) => void | Promise<void>;
  readonly now?: () => string;
}

export interface ProcessedInboundResult {
  readonly proposal: EventProposalDto;
  readonly revision: StoredReportRevision;
  readonly isCorrelated: boolean;
}

export interface CoordinatesValidationResult {
  readonly valid: boolean;
  readonly normalized?: readonly [number, number];
  readonly error?: string;
}

export interface EventValidationResult {
  readonly valid: boolean;
  readonly event?: InboundIncidentEvent;
  readonly error?: string;
}


const VALID_SEVERITIES: Record<string, true> = {
  low: true,
  medium: true,
  high: true,
  critical: true,
};

/**
 * Checks whether the request path matches the ingestion webhook route.
 */
export function isWebhookIngestPath(pathname: string): boolean {
  return pathname === "/api/v1/ingestion/events" || pathname === "/api/v1/ingestion/events/" ||
         pathname === "/api/v1/ingest/incident" || pathname === "/api/v1/ingest/incident/";
}

/**
 * Validates that coordinates fall within the DKI Jakarta bounding envelope.
 * Supports both [longitude, latitude] and [latitude, longitude], normalizing to [longitude, latitude].
 */
export function validateEnvelopeCoordinates(coords: unknown): CoordinatesValidationResult {
  if (coords === undefined || coords === null) {
    return { valid: true };
  }

  if (!Array.isArray(coords) || coords.length !== 2) {
    return {
      valid: false,
      error: "Coordinates must be a 2-element array [longitude, latitude]",
    };
  }

  const [c0, c1] = coords as readonly unknown[];
  if (
    typeof c0 !== "number" ||
    typeof c1 !== "number" ||
    !Number.isFinite(c0) ||
    !Number.isFinite(c1)
  ) {
    return {
      valid: false,
      error: "Coordinates elements must be finite numbers",
    };
  }

  // Check standard GeoJSON [lng, lat]
  if (
    c0 >= JAKARTA_ENVELOPE.west &&
    c0 <= JAKARTA_ENVELOPE.east &&
    c1 >= JAKARTA_ENVELOPE.south &&
    c1 <= JAKARTA_ENVELOPE.north
  ) {
    return { valid: true, normalized: [c0, c1] };
  }

  // Check reversed [lat, lng]
  if (
    c1 >= JAKARTA_ENVELOPE.west &&
    c1 <= JAKARTA_ENVELOPE.east &&
    c0 >= JAKARTA_ENVELOPE.south &&
    c0 <= JAKARTA_ENVELOPE.north
  ) {
    return { valid: true, normalized: [c1, c0] };
  }

  return {
    valid: false,
    error: `Coordinates must fall within DKI Jakarta bounding envelope [west=${JAKARTA_ENVELOPE.west}, south=${JAKARTA_ENVELOPE.south}, east=${JAKARTA_ENVELOPE.east}, north=${JAKARTA_ENVELOPE.north}]`,
  };
}

/**
 * Validates untrusted payload as an InboundIncidentEvent.
 */
export function validateInboundIncidentEvent(input: unknown): EventValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      valid: false,
      error: "Event payload must be a non-null object",
    };
  }

  const obj = input as Record<string, unknown>;

  // 1. source_id validation
  if (typeof obj.source_id !== "string" || obj.source_id.trim().length === 0) {
    return {
      valid: false,
      error: "Field 'source_id' is required and must be a non-empty string",
    };
  }

  // 2. title validation
  if (typeof obj.title !== "string" || obj.title.trim().length === 0) {
    return {
      valid: false,
      error: "Field 'title' is required and must be a non-empty string",
    };
  }

  // 3. text validation (minimum length 8)
  if (typeof obj.text !== "string" || obj.text.trim().length < 8) {
    return {
      valid: false,
      error: "Field 'text' is required and must contain at least 8 characters",
    };
  }

  // 4. coordinates validation
  if (obj.coordinates !== undefined && obj.coordinates !== null) {
    const coordValidation = validateEnvelopeCoordinates(obj.coordinates);
    if (!coordValidation.valid) {
      return {
        valid: false,
        error: coordValidation.error,
      };
    }
  }

  // 5. category validation
  if (obj.category !== undefined && obj.category !== null) {
    if (typeof obj.category !== "string" || obj.category.trim().length === 0) {
      return {
        valid: false,
        error: "Field 'category' when provided must be a non-empty string",
      };
    }
  }

  // 6. severity validation
  if (obj.severity !== undefined && obj.severity !== null) {
    if (typeof obj.severity !== "string" || !VALID_SEVERITIES[obj.severity]) {
      return {
        valid: false,
        error: `Invalid severity '${String(obj.severity)}'. Allowed severities: low, medium, high, critical`,
      };
    }
  }

  // 7. timestamp validation
  if (obj.timestamp !== undefined && obj.timestamp !== null) {
    if (typeof obj.timestamp !== "string" || Number.isNaN(Date.parse(obj.timestamp))) {
      return {
        valid: false,
        error: "Field 'timestamp' must be a valid parseable date string",
      };
    }
  }

  // 8. location_hint validation
  if (obj.location_hint !== undefined && obj.location_hint !== null) {
    if (typeof obj.location_hint !== "string" || obj.location_hint.trim().length === 0) {
      return {
        valid: false,
        error: "Field 'location_hint' when provided must be a non-empty string",
      };
    }
  }

  const event: InboundIncidentEvent = {
    source_id: obj.source_id.trim(),
    title: obj.title.trim(),
    text: obj.text.trim(),
    ...(typeof obj.location_hint === "string" ? { location_hint: obj.location_hint.trim() } : {}),
    ...(Array.isArray(obj.coordinates)
      ? { coordinates: validateEnvelopeCoordinates(obj.coordinates).normalized }
      : {}),
    ...(typeof obj.timestamp === "string" ? { timestamp: obj.timestamp } : {}),
    ...(typeof obj.category === "string" ? { category: obj.category as InboundIncidentEvent["category"] } : {}),
    ...(typeof obj.severity === "string" ? { severity: obj.severity as InboundIncidentEvent["severity"] } : {}),
    ...(typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
      ? { confidence: obj.confidence }
      : {}),
  };

  return { valid: true, event };
}

/**
 * Converts an InboundIncidentEvent into an immutable StoredReportRevision with chunk offsets.
 */
export async function convertInboundEventToRevision(
  event: InboundIncidentEvent,
  retrievedAt?: string,
): Promise<StoredReportRevision> {
  const nowIso = retrievedAt ?? new Date().toISOString();
  const sanitizedSource = event.source_id.replace(/[^A-Za-z0-9._:-]/g, "-");

  // Construct text for preparation
  let textToPrepare = event.text.trim();
  if (!textToPrepare.toLowerCase().includes(event.title.trim().toLowerCase())) {
    textToPrepare = `${event.title.trim()}. ${textToPrepare}`;
  }
  if (
    event.location_hint &&
    !textToPrepare.toLowerCase().includes(event.location_hint.toLowerCase())
  ) {
    textToPrepare = `${textToPrepare}\nLokasi: ${event.location_hint.trim()}`;
  }
  if (event.coordinates) {
    const coordCheck = validateEnvelopeCoordinates(event.coordinates);
    if (coordCheck.normalized && !textToPrepare.includes(`[${coordCheck.normalized[0]}`)) {
      textToPrepare = `${textToPrepare} [${coordCheck.normalized[0]}, ${coordCheck.normalized[1]}]`;
    }
  }

  const prepared = await preparePermittedText(textToPrepare);
  const hashDigest = createHash("sha256")
    .update(`${event.source_id}:${prepared.permittedTextHash}:${event.timestamp ?? nowIso}`)
    .digest("hex");
  const reportRevisionId = `webhook-${sanitizedSource}-${hashDigest.slice(0, 16)}`;
  const canonicalUrl = `webhook://${event.source_id}/${hashDigest.slice(0, 16)}`;

  // Chunking by paragraphs or single chunk
  const rawParagraphs = prepared.permittedText.split(/(?<=\n)\s*\n+/);
  const codePointsTotal = Array.from(prepared.permittedText);
  const chunks: StoredEvidenceChunk[] = [];

  if (rawParagraphs.length > 1) {
    let currentSearchOffset = 0;
    for (const pText of rawParagraphs) {
      const trimmed = pText.trim();
      if (trimmed.length === 0) continue;

      const pStartIndex = prepared.permittedText.indexOf(pText, currentSearchOffset);
      const spanStart =
        pStartIndex >= 0
          ? Array.from(prepared.permittedText.slice(0, pStartIndex)).length
          : currentSearchOffset;
      const spanEnd = spanStart + Array.from(pText).length;
      currentSearchOffset = pStartIndex >= 0 ? pStartIndex + pText.length : spanEnd;

      chunks.push({
        chunk_index: chunks.length,
        text: pText,
        span_start: spanStart,
        span_end: spanEnd,
      });
    }
  }

  if (chunks.length === 0) {
    chunks.push({
      chunk_index: 0,
      text: prepared.permittedText,
      span_start: 0,
      span_end: codePointsTotal.length,
    });
  }

  const publishedAt =
    event.timestamp && !Number.isNaN(Date.parse(event.timestamp))
      ? new Date(event.timestamp).toISOString()
      : null;

  return {
    report_revision_id: reportRevisionId,
    source_id: event.source_id,
    canonical_url: canonicalUrl,
    permitted_text: prepared.permittedText,
    permitted_text_hash: prepared.permittedTextHash,
    published_at: publishedAt,
    retrieved_at: nowIso,
    revision_status: "unreviewed",
    chunks,
  };
}

/**
 * Processes a validated InboundIncidentEvent:
 * 1. Converts into StoredReportRevision with chunk spans.
 * 2. Checks active reports for correlation via multisource-correlator.
 * 3. Generates Schema 2.0 proposal.
 * 4. Emits `broadcastModeration("proposal_created", proposal)`.
 */
export async function processInboundEvent(
  event: InboundIncidentEvent,
  options?: WebhookIngestOptions,
): Promise<ProcessedInboundResult> {
  const revision = await convertInboundEventToRevision(event, options?.now?.());
  const coordResult = validateEnvelopeCoordinates(event.coordinates);
  const normalizedCoords = coordResult.normalized;
  if (options?.onRevisionCreated) {
    await options.onRevisionCreated(revision);
  }

  // 1. Resolve active reports if provided
  let activeReportsList: readonly StoredReportRevision[] = [];
  if (options?.activeReports) {
    if (typeof options.activeReports === "function") {
      activeReportsList = await options.activeReports();
    } else {
      activeReportsList = options.activeReports;
    }
  }

  let proposal: EventProposalDto | null = null;
  let isCorrelated = false;

  // 2. Correlate with active reports if available
  if (activeReportsList.length > 0) {
    const allReports = [revision, ...activeReportsList];
    const clusters = correlateSourceReports(allReports);
    const matchingCluster = clusters.find((c) =>
      c.reports.some((r) => r.report_revision_id === revision.report_revision_id),
    );

    if (matchingCluster && matchingCluster.reports.length > 1) {
      proposal = generateCorrelatedProposal(matchingCluster, {
        proposedAt: revision.retrieved_at,
      });
      isCorrelated = true;
    }
  }

  // 3. If not correlated with multi-report cluster, generate direct proposal
  if (!proposal) {
    const rawProposal = generateProposalFromReport(revision, {
      proposedAt: revision.retrieved_at,
    });

    if (rawProposal) {
      proposal = {
        ...rawProposal,
        ...(event.category ? { incident_type: event.category as IncidentCategory } : {}),
        ...(event.severity ? { severity: event.severity } : {}),
        ...(event.location_hint ? { location_label: event.location_hint } : {}),
        ...(normalizedCoords ? { coordinates: normalizedCoords } : {}),
      };
    } else {
      // Fallback proposal construction for schema 2.0
      const cleanId = revision.report_revision_id.replace(/[^A-Za-z0-9._:-]/g, "-");
      const proposalId = cleanId.startsWith("prop-") ? cleanId : `prop-${cleanId}`;
      const firstChunk = revision.chunks[0];
      const chunkText = firstChunk ? firstChunk.text : revision.permitted_text;
      const quoteText = chunkText.slice(0, Math.min(chunkText.length, 120)).trim();

      const claims: EventProposalDto["claims"] = [
        {
          claim_id: "claim-1",
          claim_text: `${event.title} dilaporkan terjadi di lokasi kejadian.`,
          evidence_label: "under_review",
          support_assessment: "supported",
          quote_text: quoteText || event.title,
          evidence_ref_id: firstChunk
            ? `ref-${revision.report_revision_id}-${firstChunk.chunk_index}`
            : revision.report_revision_id,
        },
      ];

      proposal = {
        schema_version: "2.0",
        proposal_id: proposalId,
        title: event.title,
        incident_type: (event.category ?? "unclassified") as IncidentCategory,
        severity: (event.severity ?? "unknown") as IncidentSeverity,
        event_time: {
          precision: event.timestamp ? "exact" : "unknown",
          value: event.timestamp ?? revision.retrieved_at,
        },
        location_label: event.location_hint ?? null,
        coordinates: normalizedCoords ?? null,
        claims,
        proposed_at: revision.retrieved_at,
      };
    }
  }

  // 4. Notify broadcaster and callbacks
  const broadcaster = options?.broadcaster ?? eventBroadcaster;
  broadcaster.broadcastModeration("proposal_created", proposal!);

  if (options?.onProposalCreated) {
    await options.onProposalCreated(proposal!, revision.chunks);
  }

  return {
    proposal: proposal!,
    revision,
    isCorrelated,
  };
}

/**
 * Inbound webhook handler accepting `POST /api/v1/ingestion/events`.
 */
export async function webhookIngestHandler(
  request: Request,
  options?: WebhookIngestOptions,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "Method not allowed. Use POST." }),
      {
        status: 405,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Allow: "POST",
        },
      },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: "Invalid JSON body" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
  }

  const isBatch =
    Array.isArray(body) ||
    (body !== null &&
      typeof body === "object" &&
      Array.isArray((body as Record<string, unknown>).events));

  const rawEvents: readonly unknown[] = Array.isArray(body)
    ? body
    : body !== null &&
      typeof body === "object" &&
      Array.isArray((body as Record<string, unknown>).events)
    ? ((body as Record<string, unknown>).events as readonly unknown[])
    : [body];

  if (rawEvents.length === 0) {
    return new Response(
      JSON.stringify({ ok: false, error: "Empty batch of events" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
  }

  // Validate all events before processing
  const validatedEvents: InboundIncidentEvent[] = [];
  for (let idx = 0; idx < rawEvents.length; idx++) {
    const check = validateInboundIncidentEvent(rawEvents[idx]);
    if (!check.valid || !check.event) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: isBatch ? `Event at index ${idx}: ${check.error}` : check.error,
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        },
      );
    }
    validatedEvents.push(check.event);
  }

  // Process all validated events
  const results: ProcessedInboundResult[] = [];
  for (const event of validatedEvents) {
    const res = await processInboundEvent(event, options);
    results.push(res);
  }

  const firstResult = results[0]!;

  if (isBatch) {
    return new Response(
      JSON.stringify({
        ok: true,
        proposal_id: firstResult.proposal.proposal_id,
        proposal: firstResult.proposal,
        proposals: results.map((r) => r.proposal),
        count: results.length,
        is_correlated: results.some((r) => r.isCorrelated),
      }),
      {
        status: 201,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      proposal_id: firstResult.proposal.proposal_id,
      proposal: firstResult.proposal,
      is_correlated: firstResult.isCorrelated,
    }),
    {
      status: 201,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    },
  );
}

/**
 * Creates an HTTP handler bound with specified options.
 */
export function createWebhookIngestHandler(
  options?: WebhookIngestOptions,
): (request: Request) => Promise<Response> {
  return (request: Request) => webhookIngestHandler(request, options);
}
