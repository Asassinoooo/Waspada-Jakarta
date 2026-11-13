/**
 * Layer 4 Moderation API Handler for Waspada Jakarta.
 * Governed by ADR-006, MOD-01-AUTHZ-POLICY-CORE, and Schema 2.0.
 *
 * Implements:
 * - GET  /api/v1/moderation/proposals
 * - GET  /api/v1/moderation/proposals/:id
 * - POST /api/v1/moderation/proposals/:id/publish
 */

import type { AccountRole, AccountStore } from "../../../../db/src/accounts.js";
import type { AccountCookieMode } from "../../accounts/types.js";
import { readAccountAuthentication } from "../../accounts/api.js";
import { isOfficialIncidentCategory } from "../../../../db/src/incident-categories.js";
import {
  authorizeModeratorAction,
  type ModeratorAction,
  type ModeratorDataset,
} from "./moderator-authorization.js";
import {
  WITHDRAWAL_REASON_CATEGORIES,
  type WithdrawalReasonCategory,
} from "./proposal-publication.js";

/** Evidence labels a moderator may publish with. Anything else is rejected with 400. */
export const ALLOWED_EVIDENCE_LABELS = ["attributed_report", "crowdsourced_observation"] as const;

// ============================================================================

/** L1 -> L2 Frozen Contract: Stored Evidence Chunk */
export interface StoredEvidenceChunk {
  readonly chunk_index: number;
  readonly text: string;
  readonly span_start: number;
  readonly span_end: number;
}

/** L1 -> L2 Frozen Contract: Stored Report Revision */
export interface StoredReportRevision {
  readonly report_revision_id: string;
  readonly source_id: string;
  readonly canonical_url: string;
  readonly permitted_text: string;
  readonly permitted_text_hash: string;
  readonly published_at: string | null;
  readonly retrieved_at: string;
  readonly revision_status: "unreviewed";
  readonly chunks: readonly StoredEvidenceChunk[];
}

/** L2 -> L4 Frozen Contract: EventProposalDto (Schema 2.0) */
export interface EventProposalDto {
  readonly schema_version: "2.0";
  readonly proposal_id: string;
  readonly title: string;
  readonly incident_type: string;
  /** Canonical WJ-INT-02 primary category; present when produced by the Mastra pipeline. */
  readonly primary_category?: string;
  readonly severity: "low" | "medium" | "high" | "critical" | "unknown";
  readonly event_time: {
    readonly precision: "exact" | "date" | "range" | "unknown";
    readonly value: string | null;
  };
  readonly location_label: string | null;
  readonly coordinates: readonly [longitude: number, latitude: number] | null;
  readonly claims: readonly {
    readonly claim_id: string;
    readonly claim_text: string;
    readonly evidence_label: "under_review" | "attributed_report" | "issuer_notice" | "crowdsourced_observation" | "independent_corroboration";
    readonly support_assessment: "supported" | "uncertain" | "disputed";
    readonly quote_text: string;
    readonly evidence_ref_id: string;
    /** MERGE-REVIEW-01: the claim's publisher and its article link. */
    readonly source_id?: string | null;
    readonly outlet?: string | null;
    readonly source_url?: string | null;
    /** Legacy field, never written by new code. */
    readonly is_corroborated?: boolean;
  }[];
  readonly is_multi_source?: boolean;
  readonly source_count?: number;
  readonly has_discrepancy?: boolean;
  readonly discrepancy_summary?: string | null;
  readonly correlation_relationship?: "primary_initial" | "corroborating" | "unresolved";
  readonly incident_id?: string | null;
  readonly discrepancies?: readonly unknown[];
  readonly caveats?: readonly string[];
  readonly impacts?: readonly string[];
  /** WJ-INT-02B: interpreter's independent category for moderator resolution. */
  readonly interpretation_category?: string | null;
  /** WJ-INT-02B: registry source id for the public-display rights gate. */
  readonly source_id?: string | null;
  readonly proposed_at: string;
}
export interface ModeratorDecisionCommand {
  readonly proposal_id: string;
  readonly action: "publish" | "reject" | "investigate";
  readonly evidence_label: "attributed_report" | "crowdsourced_observation";
  readonly reason?: string;
  /** WJ-INT-02B: required to publish a proposal whose record carries an
   *  unresolved triage/interpreter category mismatch. */
  readonly category_resolution?: "accept_triage" | "accept_interpretation";
}
// ============================================================================
// Moderation API Interfaces & Types
// ============================================================================

export interface ModerationPrincipal {
  readonly actorId: string;
  readonly role: AccountRole | string;
  readonly active: boolean;
  readonly csrfToken?: string | null;
  readonly channel?: "web" | "mobile";
  readonly datasetScope?: "live" | "historical" | "synthetic";
}

export interface ModerationProposalDetail {
  readonly proposal: EventProposalDto;
  readonly chunks: readonly StoredEvidenceChunk[];
}

export interface ModerationProposalReader {
  listPending?(): Promise<readonly EventProposalDto[]>;
  readDetail?(proposalId: string): Promise<ModerationProposalDetail | null>;
  readLive?(proposalId: string): Promise<unknown>;
}

export interface ModerationPublisher {
  publish(input: unknown): Promise<unknown>;
}

export interface ModerationApiDependencies {
  readonly proposalReader?: ModerationProposalReader;
  readonly publicationService?: ModerationPublisher;
  readonly publisher?: ModerationPublisher;
  /**
   * MERGE-REVIEW-01: records a moderator rejection. Rejection never publishes. Absent means
   * rejection is unavailable (503), so nothing is silently treated as done.
   */
  readonly rejectProposal?: (
    proposalId: string,
    command: ModeratorDecisionCommand,
    principal: ModerationPrincipal,
  ) => Promise<{ readonly status: "rejected" | "already_decided" | "denied"; readonly code?: string }>;
  /**
   * TG-FR12: withdraws a published event. Absent means withdrawal is unavailable (503). Requires
   * retract_information, which only a moderator or admin holds.
   */
  readonly withdrawEvent?: (
    eventId: string,
    command: EventWithdrawalCommand,
    principal: ModerationPrincipal,
  ) => Promise<EventWithdrawalResult>;
  /**
   * TG-FR12: submits a correction to a published event through the moderator gate. Absent means
   * corrections are unavailable (503). Requires submit_correction.
   */
  readonly submitCorrection?: (
    eventId: string,
    command: EventCorrectionCommand,
    principal: ModerationPrincipal,
  ) => Promise<EventCorrectionResult>;
  /** Account store for the cookie session. Used only when `authenticate` is not supplied. */
  readonly accountStore?: AccountStore;
  readonly authenticate?: (request: Request) => Promise<ModerationPrincipal | null>;
  readonly principal?: ModerationPrincipal | null;
  readonly listPendingProposals?: () => Promise<readonly EventProposalDto[]>;
  readonly getProposalDetail?: (proposalId: string) => Promise<ModerationProposalDetail | null>;
  readonly proposals?: readonly EventProposalDto[];
  readonly listUncertainTriage?: (options?: { limit?: number }) => Promise<readonly TriageReviewItem[]>;
  readonly markTriageReviewed?: (itemIdentityHash: string, actorId: string) => Promise<boolean>;
  readonly chunks?:
    | ReadonlyMap<string, readonly StoredEvidenceChunk[]>
    | Record<string, readonly StoredEvidenceChunk[]>;
  readonly buildPublicationInput?: (
    proposalId: string,
    command: ModeratorDecisionCommand,
    principal: ModerationPrincipal,
  ) => Promise<unknown> | unknown;
  /**
   * WJ-INT-02B public-display rights gate. When the proposal carries a
   * source_id and this checker is wired, publication is denied (403) unless
   * the source's current registry permissions grant public display.
   * Moderator approval never overrides missing redistribution rights.
   */
  readonly checkPublicDisplay?: (sourceId: string) => Promise<boolean>;
  readonly appOrigin?: string;
  readonly cookieMode?: AccountCookieMode;
  readonly expectedCsrfToken?: string;
  /** false disables browser-write checks. Production composition must leave this unset or true. */
  readonly csrfProtection?: boolean;
  /** Server-selected dataset. Principals outside this dataset are denied. Absent means deny. */
  readonly datasetScope?: ModeratorDataset;
  readonly now?: () => number;
}

/** WJ-INT-02A inspection-only uncertain queue item: metadata, never content. */
export interface TriageReviewItem {
  readonly source_id: string;
  readonly item_identity_hash: string;
  readonly disposition: string;
  readonly jakarta_scope: string;
  readonly actionability: string;
  readonly primary_category: string | null;
  readonly incident_type: string | null;
  readonly confidence: string;
  readonly reason_codes: readonly string[];
  readonly model_status: string;
  readonly policy_version: string;
  readonly evaluated_at: string;
  readonly reviewed_at: string | null;
  readonly reviewed_by: string | null;
}

export type ModerationApiHandler = (request: Request) => Promise<Response | undefined>;

/** TG-FR12: a validated withdrawal request. `reason` stays internal; the public record shows only the category. */
export interface EventWithdrawalCommand {
  readonly reason: string;
  readonly reason_category: WithdrawalReasonCategory;
}

/** TG-FR12: a validated correction request. Claim edits name existing public claim ids and change only claim text. */
export interface EventCorrectionCommand {
  readonly base_version: number;
  readonly title?: string;
  readonly category?: string;
  readonly event_time?: { readonly precision: "exact" | "date" | "range"; readonly value: string };
  readonly location_label?: string;
  readonly claims?: readonly { readonly claim_id: string; readonly claim_text: string }[];
  readonly reason?: string;
}

export type EventWithdrawalResult =
  | {
    readonly status: "withdrawn";
    readonly event_id: string;
    readonly version: number;
    readonly decision_id: string;
    readonly withdrawn_at: string;
    readonly withdrawal_reason: string;
  }
  | { readonly status: "already_withdrawn"; readonly event_id: string; readonly version: number }
  | { readonly status: "not_found" }
  | { readonly status: "denied"; readonly code: string };

export type EventCorrectionResult =
  | {
    readonly status: "published";
    readonly event_id: string;
    readonly version: number;
    readonly proposal_id: string;
    readonly decision_id: string;
  }
  | {
    readonly status: "unchanged";
    readonly event_id: string;
    readonly version: number;
    readonly proposal_id: string;
    readonly decision_id: string;
  }
  | { readonly status: "refused"; readonly code: string; readonly reasons: readonly string[]; readonly proposal_id?: string }
  | { readonly status: "invalid"; readonly code: string }
  | { readonly status: "not_found" };

// ============================================================================
// Constants & Utilities
// ============================================================================

const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

function jsonResponse(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...(extraHeaders ? Object.fromEntries(new Headers(extraHeaders).entries()) : {}),
    },
  });
}

function apiError(code: string, message: string, status: number): Response {
  return jsonResponse(
    {
      code,
      message,
      request_id: crypto.randomUUID(),
    },
    status,
  );
}

// ============================================================================
// Path & Route Parsing
// ============================================================================

export function isModerationPath(pathname: string): boolean {
  return pathname === "/api/v1/moderation" || pathname.startsWith("/api/v1/moderation/");
}

type ParsedModerationRoute =
  | { readonly kind: "list" }
  | { readonly kind: "detail"; readonly proposalId: string }
  | { readonly kind: "publish"; readonly proposalId: string }
  | { readonly kind: "triage-list" }
  | { readonly kind: "triage-review" }
  | { readonly kind: "withdraw"; readonly eventId: string }
  | { readonly kind: "correction"; readonly eventId: string }
  | { readonly kind: "method_not_allowed"; readonly allowed: string }
  | { readonly kind: "not_found" };

function parseModerationRoute(pathname: string, method: string): ParsedModerationRoute | null {
  if (!isModerationPath(pathname)) {
    return null;
  }
  const cleanPath = pathname.replace(/\/+$/, "");
  if (cleanPath === "/api/v1/moderation/proposals") {
    if (method === "GET") return { kind: "list" };
    return { kind: "method_not_allowed", allowed: "GET" };
  }
  // WJ-INT-02A inspection-only uncertain queue. Reevaluation happens only via
  // the next authorized poll cycle (new attempt row), never via a
  // promote-to-ingest or refetch action here.
  if (cleanPath === "/api/v1/moderation/triage") {
    if (method === "GET") return { kind: "triage-list" };
    return { kind: "method_not_allowed", allowed: "GET" };
  }
  if (cleanPath === "/api/v1/moderation/triage/review") {
    if (method === "POST") return { kind: "triage-review" };
    return { kind: "method_not_allowed", allowed: "POST" };
  }
  // TG-FR12: withdrawal and correction of a published event.
  const eventMatch = cleanPath.match(/^\/api\/v1\/moderation\/events\/([^/]+)\/(withdraw|corrections)$/);
  if (eventMatch) {
    const eventId = decodeURIComponent(eventMatch[1]!);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(eventId)) return { kind: "not_found" };
    const kind = eventMatch[2] === "withdraw" ? "withdraw" : "correction";
    if (method === "POST") return { kind, eventId };
    return { kind: "method_not_allowed", allowed: "POST" };
  }
  const match = cleanPath.match(/^\/api\/v1\/moderation\/proposals\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) {
    return { kind: "not_found" };
  }
  const rawId = match[1]!;
  if (!rawId || rawId.trim().length === 0 || rawId.length > 256) {
    return { kind: "not_found" };
  }
  const proposalId = decodeURIComponent(rawId);
  const subAction = match[2];
  if (!subAction) {
    if (method === "GET") return { kind: "detail", proposalId };
    return { kind: "method_not_allowed", allowed: "GET" };
  }
  if (subAction === "publish") {
    if (method === "POST") return { kind: "publish", proposalId };
    return { kind: "method_not_allowed", allowed: "POST" };
  }
  return { kind: "not_found" };
}

// ============================================================================
// Authentication & Authorization
// ============================================================================

async function resolvePrincipal(
  request: Request,
  dependencies: ModerationApiDependencies,
): Promise<ModerationPrincipal | null> {
  if (dependencies.authenticate) {
    return dependencies.authenticate(request);
  }
  if (dependencies.accountStore) {
    // Moderation accepts only the browser cookie session, never a bearer token.
    const auth = await readAccountAuthentication(
      request,
      dependencies.accountStore,
      dependencies.now ?? Date.now,
      dependencies.cookieMode ?? "host",
    );
    if (!auth || auth.source !== "cookie" || auth.session.channel !== "web") return null;
    return {
      actorId: auth.session.account.id,
      role: auth.session.account.role,
      active: auth.session.account.active,
      csrfToken: auth.session.csrfToken,
      channel: "web",
    };
  }
  if (dependencies.principal !== undefined) {
    return dependencies.principal;
  }
  return null;
}

type AuthorizationOutcome =
  | { readonly authorized: true; readonly principal: ModerationPrincipal }
  | {
    readonly authorized: false;
    readonly status: number;
    readonly code: string;
    readonly message: string;
  };

/** Delegates the role and dataset decision to the closed authorization vocabulary. */
function checkAuthorization(
  principal: ModerationPrincipal | null,
  action: ModeratorAction,
  dependencies: ModerationApiDependencies,
): AuthorizationOutcome {
  if (!principal) {
    return {
      authorized: false,
      status: 401,
      code: "UNAUTHORIZED",
      message: "Authentication required to access moderation endpoints",
    };
  }
  const datasetScope = dependencies.datasetScope;
  const decision = authorizeModeratorAction({
    principal: {
      actorId: principal.actorId,
      role: principal.role as "moderator" | "admin",
      active: principal.active,
      datasetScope: (principal.datasetScope ?? datasetScope) as ModeratorDataset,
    },
    action,
    targetDataset: datasetScope as ModeratorDataset,
    serverSelectedDataset: datasetScope as ModeratorDataset,
  });
  if (decision.decision === "allow") return { authorized: true, principal };
  if (decision.reasonCode === "principal_missing") {
    return { authorized: false, status: 401, code: "UNAUTHORIZED", message: "Authentication required to access moderation endpoints" };
  }
  if (decision.reasonCode === "principal_inactive") {
    return { authorized: false, status: 403, code: "ACCOUNT_INACTIVE", message: "Account is inactive" };
  }
  return {
    authorized: false,
    status: 403,
    code: "FORBIDDEN",
    message: "Forbidden: requires active user with moderator or admin role",
  };
}

type CsrfOutcome =
  | { readonly valid: true }
  | {
    readonly valid: false;
    readonly status: number;
    readonly code: string;
    readonly message: string;
  };

/**
 * Browser writes need the exact application Origin and the session CSRF token. Principals
 * without a session token fail closed, so an injected principal cannot skip the token check.
 */
function checkCsrf(
  request: Request,
  principal: ModerationPrincipal,
  dependencies: ModerationApiDependencies,
): CsrfOutcome {
  if (dependencies.csrfProtection === false) {
    return { valid: true };
  }
  if (dependencies.appOrigin !== undefined && request.headers.get("origin") !== dependencies.appOrigin) {
    return {
      valid: false,
      status: 403,
      code: "CSRF_ORIGIN_MISMATCH",
      message: "Origin header does not match expected application origin",
    };
  }
  const expectedCsrfToken = principal.csrfToken ?? dependencies.expectedCsrfToken ?? null;
  const csrfHeader = request.headers.get("x-csrf-token");
  if (expectedCsrfToken === null || csrfHeader === null || !constantTimeEqualText(csrfHeader, expectedCsrfToken)) {
    return {
      valid: false,
      status: 403,
      code: "CSRF_TOKEN_INVALID",
      message: "Invalid or missing CSRF token",
    };
  }
  return { valid: true };
}

function constantTimeEqualText(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
}

// ============================================================================
// Data Resolution Helpers
// ============================================================================

async function fetchPendingProposals(
  dependencies: ModerationApiDependencies,
): Promise<readonly EventProposalDto[]> {
  if (dependencies.listPendingProposals) {
    return dependencies.listPendingProposals();
  }
  if (dependencies.proposalReader?.listPending) {
    return dependencies.proposalReader.listPending();
  }
  if (dependencies.proposals) {
    return dependencies.proposals;
  }
  return [];
}

async function fetchProposalDetail(
  proposalId: string,
  dependencies: ModerationApiDependencies,
): Promise<ModerationProposalDetail | null> {
  if (dependencies.getProposalDetail) {
    return dependencies.getProposalDetail(proposalId);
  }
  if (dependencies.proposalReader?.readDetail) {
    return dependencies.proposalReader.readDetail(proposalId);
  }
  if (dependencies.proposals) {
    const found = dependencies.proposals.find((p) => p.proposal_id === proposalId);
    if (!found) return null;
    let chunks: readonly StoredEvidenceChunk[] = [];
    if (dependencies.chunks) {
      if (dependencies.chunks instanceof Map) {
        chunks = dependencies.chunks.get(proposalId) ?? [];
      } else if (typeof dependencies.chunks === "object") {
        chunks = (dependencies.chunks as Record<string, readonly StoredEvidenceChunk[]>)[proposalId] ?? [];
      }
    }
    return { proposal: found, chunks };
  }
  return null;
}

// ============================================================================
// TG-FR12: withdrawal and correction request checks
// ============================================================================

type BodyCheck<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

function invalidBody(code: string, message: string): { readonly ok: false; readonly code: string; readonly message: string } {
  return { ok: false, code, message };
}

function checkWithdrawalBody(body: Record<string, unknown>): BodyCheck<EventWithdrawalCommand> {
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 10 || reason.length > 500) {
    return invalidBody("INVALID_REASON", "reason must be 10 to 500 characters");
  }
  const category = body.reason_category;
  if (typeof category !== "string" || !(WITHDRAWAL_REASON_CATEGORIES as readonly string[]).includes(category)) {
    return invalidBody("INVALID_REASON_CATEGORY", "reason_category must be one of the contract withdrawal reasons");
  }
  return { ok: true, value: { reason, reason_category: category as WithdrawalReasonCategory } };
}

function checkCorrectionBody(body: Record<string, unknown>): BodyCheck<EventCorrectionCommand> {
  const baseVersion = body.base_version;
  if (typeof baseVersion !== "number" || !Number.isInteger(baseVersion) || baseVersion < 1) {
    return invalidBody("INVALID_BASE_VERSION", "base_version must be the integer version being corrected");
  }

  let title: string | undefined;
  if (body.title !== undefined) {
    const value = typeof body.title === "string" ? body.title.trim() : "";
    if (value.length < 3 || value.length > 240) return invalidBody("INVALID_TITLE", "title must be 3 to 240 characters");
    title = value;
  }

  let category: string | undefined;
  if (body.category !== undefined) {
    if (typeof body.category !== "string" || !isOfficialIncidentCategory(body.category)) {
      return invalidBody("INVALID_CATEGORY", "category must be an official incident category");
    }
    category = body.category;
  }

  let locationLabel: string | undefined;
  if (body.location_label !== undefined) {
    const value = typeof body.location_label === "string" ? body.location_label.trim() : "";
    if (value.length < 1 || value.length > 200) return invalidBody("INVALID_LOCATION", "location_label must be 1 to 200 characters");
    locationLabel = value;
  }

  let eventTime: { readonly precision: "exact" | "date" | "range"; readonly value: string } | undefined;
  if (body.event_time !== undefined) {
    const raw = body.event_time as Record<string, unknown> | null;
    const precision = raw && typeof raw === "object" ? raw.precision : undefined;
    const value = raw && typeof raw === "object" ? raw.value : undefined;
    if (
      precision !== "exact" && precision !== "date" && precision !== "range"
      || typeof value !== "string"
      || !Number.isFinite(Date.parse(value))
    ) {
      return invalidBody("INVALID_EVENT_TIME", "event_time needs a precision of exact, date or range and a parseable value");
    }
    eventTime = { precision, value };
  }

  let claims: { readonly claim_id: string; readonly claim_text: string }[] | undefined;
  if (body.claims !== undefined) {
    if (!Array.isArray(body.claims) || body.claims.length > 50) {
      return invalidBody("INVALID_CLAIMS", "claims must be a list of at most 50 claim edits");
    }
    const parsed: { claim_id: string; claim_text: string }[] = [];
    for (const item of body.claims) {
      const edit = item as Record<string, unknown> | null;
      const text = edit && typeof edit === "object" && typeof edit.claim_text === "string" ? edit.claim_text.trim() : "";
      if (
        !edit || typeof edit !== "object"
        || typeof edit.claim_id !== "string" || edit.claim_id.length === 0 || edit.claim_id.length > 128
        || text.length === 0 || text.length > 500
      ) {
        return invalidBody("INVALID_CLAIMS", "each claim edit needs a claim_id and a claim_text of 1 to 500 characters");
      }
      parsed.push({ claim_id: edit.claim_id, claim_text: text });
    }
    claims = parsed;
  }

  let reason: string | undefined;
  if (body.reason !== undefined) {
    const value = typeof body.reason === "string" ? body.reason.trim() : "";
    if (value.length < 10 || value.length > 500) return invalidBody("INVALID_REASON", "reason must be 10 to 500 characters when given");
    reason = value;
  }

  return {
    ok: true,
    value: {
      base_version: baseVersion,
      ...(title !== undefined ? { title } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(locationLabel !== undefined ? { location_label: locationLabel } : {}),
      ...(eventTime !== undefined ? { event_time: eventTime } : {}),
      ...(claims !== undefined ? { claims } : {}),
      ...(reason !== undefined ? { reason } : {}),
    },
  };
}

function withdrawalResponse(result: EventWithdrawalResult): Response {
  if (result.status === "withdrawn") return jsonResponse({ ok: true, ...result }, 200);
  if (result.status === "already_withdrawn") {
    return apiError("ALREADY_WITHDRAWN", `Event ${result.event_id} is already withdrawn`, 409);
  }
  if (result.status === "not_found") return apiError("EVENT_NOT_FOUND", "The event has no published version", 404);
  return apiError("WITHDRAWAL_FAILED", "The withdrawal could not be recorded", 502);
}

function correctionResponse(result: EventCorrectionResult): Response {
  if (result.status === "published" || result.status === "unchanged") return jsonResponse({ ok: true, ...result }, 200);
  if (result.status === "not_found") return apiError("EVENT_NOT_FOUND", "The event has no published version", 404);
  if (result.status === "invalid") {
    return apiError("CLAIM_NOT_FOUND", "A claim_id does not name a claim of this event", 400);
  }
  if (result.code === "stale_base_version") {
    return apiError("STALE_BASE_VERSION", "The event changed since base_version; reload it and try again", 409);
  }
  if (result.code === "event_withdrawn") return apiError("EVENT_WITHDRAWN", "A withdrawn event cannot be corrected", 409);
  if (result.code === "investigation_stopped_for_review") {
    return apiError("INVESTIGATION_STOPPED_FOR_REVIEW", "The linked case must be resolved before the event is corrected", 409);
  }
  if (result.code === "publication_failed") return apiError("CORRECTION_FAILED", "The correction could not be recorded", 502);
  return jsonResponse(
    {
      code: "CORRECTION_NOT_PUBLISHABLE",
      message: "The correction did not pass the publication gate and nothing was published",
      reasons: [...result.reasons],
      proposal_id: result.proposal_id ?? null,
      request_id: crypto.randomUUID(),
    },
    422,
  );
}

// ============================================================================
// Main Factory
// ============================================================================

/**
 * Creates the Layer 4 Moderation API request handler.
 * Dispatches:
 * - GET  /api/v1/moderation/proposals
 * - GET  /api/v1/moderation/proposals/:id
 * - POST /api/v1/moderation/proposals/:id/publish
 */
export function createModerationApiHandler(
  dependencies: ModerationApiDependencies = {},
): ModerationApiHandler {
  return async function handleModerationRequest(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url, "http://localhost");
    const route = parseModerationRoute(url.pathname, request.method);

    if (route === null) {
      return undefined;
    }

    if (route.kind === "method_not_allowed") {
      return apiError(
        "METHOD_NOT_ALLOWED",
        `Method ${request.method} is not allowed. Allowed: ${route.allowed}`,
        405,
      );
    }

    if (route.kind === "not_found") {
      return apiError("NOT_FOUND", `The moderation route ${url.pathname} was not found`, 404);
    }

    // Authentication and role authorization required on all moderation endpoints.
    // Publication is a stronger action than evidence review, so it is decided separately.
    const principal = await resolvePrincipal(request, dependencies);
    const action: ModeratorAction = route.kind === "publish"
      ? "approve_publication"
      : route.kind === "withdraw"
        ? "retract_information"
        : route.kind === "correction"
          ? "submit_correction"
          : "review_evidence";
    const authResult = checkAuthorization(principal, action, dependencies);
    if (!authResult.authorized) {
      return apiError(authResult.code, authResult.message, authResult.status);
    }
    const currentPrincipal = authResult.principal;

    // TG-FR12: withdrawal and correction of a published event. Order: CSRF, then the configured writer, then the
    // body. Nothing is written before the request has passed each check.
    if (route.kind === "withdraw" || route.kind === "correction") {
      const csrfCheck = checkCsrf(request, currentPrincipal, dependencies);
      if (!csrfCheck.valid) {
        return apiError(csrfCheck.code, csrfCheck.message, csrfCheck.status);
      }
      const withdrawEvent = dependencies.withdrawEvent;
      const submitCorrection = dependencies.submitCorrection;
      if (route.kind === "withdraw" && !withdrawEvent) {
        return apiError("WITHDRAWAL_UNAVAILABLE", "Event withdrawal is not configured", 503);
      }
      if (route.kind === "correction" && !submitCorrection) {
        return apiError("CORRECTION_UNAVAILABLE", "Event correction is not configured", 503);
      }
      let body: Record<string, unknown>;
      try {
        const rawText = await request.text();
        const parsed: unknown = rawText.trim().length > 0 ? JSON.parse(rawText) : {};
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return apiError("INVALID_JSON", "Request body must be a JSON object", 400);
        }
        body = parsed as Record<string, unknown>;
      } catch {
        return apiError("INVALID_JSON", "Malformed JSON payload", 400);
      }
      try {
        if (route.kind === "withdraw") {
          const checked = checkWithdrawalBody(body);
          if (!checked.ok) return apiError(checked.code, checked.message, 400);
          return withdrawalResponse(await withdrawEvent!(route.eventId, checked.value, currentPrincipal));
        }
        const checked = checkCorrectionBody(body);
        if (!checked.ok) return apiError(checked.code, checked.message, 400);
        return correctionResponse(await submitCorrection!(route.eventId, checked.value, currentPrincipal));
      } catch {
        return apiError("EVENT_ACTION_FAILED", "The event action could not be completed", 500);
      }
    }

    // 1. GET /api/v1/moderation/proposals
    if (route.kind === "list") {
      const proposals = await fetchPendingProposals(dependencies);
      return jsonResponse(
        {
          proposals,
          items: proposals,
        },
        200,
      );
    }

    // WJ-INT-02A GET /api/v1/moderation/triage — inspection-only uncertain
    // queue. Metadata only: no title, description, URL, or chunk text.
    if (route.kind === "triage-list") {
      const reader = dependencies.listUncertainTriage;
      if (!reader) {
        return apiError("TRIAGE_UNAVAILABLE", "Uncertain triage review is not configured", 503);
      }
      const limitParam = new URL(request.url, "http://localhost").searchParams.get("limit");
      const limit = limitParam === null ? 100 : Math.max(1, Math.min(100, Math.floor(Number(limitParam) || 100)));
      const items = await reader({ limit });
      return jsonResponse({ items, total: items.length }, 200);
    }

    // WJ-INT-02A POST /api/v1/moderation/triage/review — inspection-only
    // reviewed flag. No promote-to-ingest, no refetch, no re-ingest path.
    if (route.kind === "triage-review") {
      const csrfCheck = checkCsrf(request, currentPrincipal, dependencies);
      if (!csrfCheck.valid) {
        return apiError(csrfCheck.code, csrfCheck.message, csrfCheck.status);
      }
      let body: Record<string, unknown> = {};
      try {
        const rawText = await request.text();
        if (rawText.trim().length > 0) {
          body = JSON.parse(rawText);
          if (typeof body !== "object" || body === null || Array.isArray(body)) {
            return apiError("INVALID_JSON", "Request body must be a JSON object", 400);
          }
        }
      } catch {
        return apiError("INVALID_JSON", "Malformed JSON payload", 400);
      }
      const hash = body.item_identity_hash;
      if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
        return apiError("INVALID_JSON", "item_identity_hash must be a 64-char lowercase hex sha256", 400);
      }
      const marker = dependencies.markTriageReviewed;
      if (!marker) {
        return apiError("TRIAGE_UNAVAILABLE", "Uncertain triage review is not configured", 503);
      }
      const marked = await marker(hash, currentPrincipal.actorId);
      return jsonResponse({ ok: true, reviewed: marked }, 200);
    }

    // 2. GET /api/v1/moderation/proposals/:id
    if (route.kind === "detail") {
      const detail = await fetchProposalDetail(route.proposalId, dependencies);
      if (!detail) {
        return apiError("PROPOSAL_NOT_FOUND", `Proposal ${route.proposalId} not found`, 404);
      }
      return jsonResponse(
        {
          proposal: detail.proposal,
          chunks: detail.chunks,
          ...detail.proposal,
        },
        200,
      );
    }

    // 3. POST /api/v1/moderation/proposals/:id/publish
    if (route.kind === "publish") {
      // Validate CSRF token on POST
      const csrfCheck = checkCsrf(request, currentPrincipal, dependencies);
      if (!csrfCheck.valid) {
        return apiError(csrfCheck.code, csrfCheck.message, csrfCheck.status);
      }

      const publisher = dependencies.publicationService ?? dependencies.publisher;
      if (!publisher || typeof publisher.publish !== "function") {
        return apiError("PUBLISHER_UNAVAILABLE", "Publication service is not configured", 503);
      }

      let body: Record<string, unknown> = {};
      const contentType = request.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        try {
          const rawText = await request.text();
          if (rawText.trim().length > 0) {
            body = JSON.parse(rawText);
            if (typeof body !== "object" || body === null || Array.isArray(body)) {
              return apiError("INVALID_JSON", "Request body must be a JSON object", 400);
            }
          }
        } catch {
          return apiError("INVALID_JSON", "Malformed JSON payload", 400);
        }
      }

      // If a proposal reader/getter is configured, verify existence first
      if (dependencies.getProposalDetail || dependencies.proposalReader?.readDetail) {
        const existing = await fetchProposalDetail(route.proposalId, dependencies);
        if (!existing) {
          return apiError("PROPOSAL_NOT_FOUND", `Proposal ${route.proposalId} not found`, 404);
        }
      }

      const requestedLabel = body.evidence_label ?? "attributed_report";
      if (typeof requestedLabel !== "string" || !(ALLOWED_EVIDENCE_LABELS as readonly string[]).includes(requestedLabel)) {
        return apiError("INVALID_EVIDENCE_LABEL", "evidence_label must be attributed_report or crowdsourced_observation", 400);
      }
      const requestedAction = body.action ?? "publish";
      if (requestedAction !== "publish" && requestedAction !== "reject") {
        return apiError("INVALID_ACTION", "action must be publish or reject", 400);
      }
      const decisionCommand: ModeratorDecisionCommand = {
        proposal_id: route.proposalId,
        action: requestedAction,
        evidence_label: requestedLabel as ModeratorDecisionCommand["evidence_label"],
        reason: typeof body.reason === "string" ? body.reason : undefined,
        category_resolution:
          body.category_resolution === "accept_triage" || body.category_resolution === "accept_interpretation"
            ? body.category_resolution
            : undefined,
      };
      // MERGE-REVIEW-01: only "publish" and "reject" exist. Reject records a decision and never
      // reaches the publisher. Any other action is refused, so nothing publishes by accident.
      if (decisionCommand.action === "reject") {
        if (!dependencies.rejectProposal) {
          return apiError("REJECTION_UNAVAILABLE", "Rejection service is not configured", 503);
        }
        let outcome: Awaited<ReturnType<NonNullable<ModerationApiDependencies["rejectProposal"]>>>;
        try {
          outcome = await dependencies.rejectProposal(route.proposalId, decisionCommand, currentPrincipal);
        } catch {
          return apiError("REJECTION_FAILED", "Rejection could not be recorded", 502);
        }
        if (outcome.status === "rejected") {
          return jsonResponse({ ok: true, status: "rejected", proposal_id: route.proposalId }, 200);
        }
        if (outcome.status === "already_decided") {
          return apiError("ALREADY_DECIDED", `Proposal ${route.proposalId} already has a publication decision`, 409);
        }
        return apiError(outcome.code ?? "REJECTION_DENIED", `Proposal ${route.proposalId} could not be rejected`, 404);
      }
      if (decisionCommand.action !== "publish") {
        return apiError("INVALID_ACTION", "action must be publish or reject", 400);
      }

      // WJ-INT-02B: a proposal carrying an unresolved triage/interpreter
      // category mismatch (workflow caveat) cannot publish until the
      // moderator explicitly resolves it. No auto-mapping, no silent
      // agreement. Structured proposals carry no such caveat and pass.
      if (decisionCommand.action === "publish") {
        const detail = await fetchProposalDetail(route.proposalId, dependencies);
        const caveats = detail?.proposal.caveats;
        if (Array.isArray(caveats) && caveats.includes("category_mismatch_review")) {
          if (!decisionCommand.category_resolution) {
            return apiError(
              "CATEGORY_MISMATCH_UNRESOLVED",
              `Proposal ${route.proposalId} has an unresolved triage/interpreter category mismatch; provide category_resolution`,
              409,
            );
          }
        }
        // WJ-INT-02B public-display rights gate: when the proposal carries
        // a source_id and a checker is wired, publication is denied unless
        // the source's current registry permissions grant public display.
        // Moderator approval never overrides missing redistribution rights.
        const proposalSourceId = (detail?.proposal as { source_id?: unknown } | undefined)?.source_id;
        if (
          typeof proposalSourceId === "string" &&
          proposalSourceId.length > 0 &&
          typeof dependencies.checkPublicDisplay === "function"
        ) {
          let allowed = false;
          try {
            allowed = await dependencies.checkPublicDisplay(proposalSourceId);
          } catch {
            allowed = false;
          }
          if (!allowed) {
            return apiError(
              "PUBLICATION_NOT_AUTHORIZED",
              `Proposal ${route.proposalId} source ${proposalSourceId} does not grant public display`,
              403,
            );
          }
        }
      }
      let publishInput: unknown;
      if (dependencies.buildPublicationInput) {
        publishInput = await dependencies.buildPublicationInput(
          route.proposalId,
          decisionCommand,
          currentPrincipal,
        );
      } else if (body.policyInput && body.eventDraft) {
        publishInput = { ...body, proposalId: route.proposalId, actorId: currentPrincipal.actorId };
      } else {
        // Authoritative fields come after the client body so a request cannot spoof the reviewer.
        publishInput = {
          ...body,
          proposalId: route.proposalId,
          proposal_id: route.proposalId,
          actorId: currentPrincipal.actorId,
          action: decisionCommand.action,
          evidence_label: decisionCommand.evidence_label,
          reason: decisionCommand.reason,
          decision: decisionCommand,
          command: decisionCommand,
        };
      }
      // WJ-INT-02B resolution-aware publication: the moderator's explicit
      // choice decides the published category, and the choice is recorded in
      // the publication input for downstream audit (no silent default wins).
      // accept_triage → proposal.primary_category; accept_interpretation →
      // proposal.interpretation_category; non-mismatch publishes keep the
      // stored canonical slug. Invalid or missing selected category → 400.
      {
        const stored = await fetchProposalDetail(route.proposalId, dependencies);
        if (stored) {
          const proposal = stored.proposal as {
            primary_category?: unknown;
            interpretation_category?: unknown;
            caveats?: readonly unknown[];
          };
          const mismatched =
            Array.isArray(proposal.caveats) && proposal.caveats.includes("category_mismatch_review");
          const rawStored = proposal.primary_category;
          let selected: unknown;
          if (mismatched && decisionCommand.action === "publish") {
            selected =
              decisionCommand.category_resolution === "accept_interpretation"
                ? proposal.interpretation_category
                : proposal.primary_category;
            if (
              typeof selected !== "string" ||
              !isOfficialIncidentCategory(selected)
            ) {
              return apiError(
                "INVALID_CATEGORY",
                `Proposal ${route.proposalId} has an unrecognized or missing selected category for resolution ${decisionCommand.category_resolution ?? "none"}`,
                400,
              );
            }
          } else if (typeof rawStored === "string") {
            if (!isOfficialIncidentCategory(rawStored)) {
              return apiError("INVALID_CATEGORY", `Proposal ${route.proposalId} has an unrecognized primary category`, 400);
            }
            selected = rawStored;
          }
          if (typeof selected === "string") {
            const input = publishInput as Record<string, unknown>;
            const draft = (input.eventDraft ?? input.event) as Record<string, unknown> | undefined;
            if (draft && typeof draft === "object") {
              draft.category = selected;
            }
            (input as Record<string, unknown>).category_resolution = decisionCommand.category_resolution ?? null;
            (input as Record<string, unknown>).resolved_category = selected;
          }
        }
      }

      try {
        // Publication accepts either publication service or arbitrary publisher input
        const result: unknown = await publisher.publish(
          publishInput as Parameters<typeof publisher.publish>[0],
        );
        if (typeof result === "object" && result !== null) {
          const rec = result as Record<string, unknown>;
          if (rec.status === "written" || rec.status === "replayed") {
            return jsonResponse(
              {
                ok: true,
                status: rec.status,
                receipt: rec.receipt,
                ...rec,
              },
              200,
            );
          }
          if (rec.status === "denied") {
            let status = 400;
            if (rec.code === "proposal_not_found") status = 404;
            else if (rec.code === "publication_not_authorized") status = 403;
            // F-04: the case must be resolved first. This is a state conflict, not a permission failure.
            else if (rec.code === "investigation_stopped_for_review") status = 409;
            else if (rec.code === "proposal_unavailable" || rec.code === "writer_failed") {
              status = 502;
            }
            return jsonResponse(
              {
                ok: false,
                status: "denied",
                code: rec.code,
                error: rec.code,
              },
              status,
            );
          }
          if (rec.status === "conflict") {
            return jsonResponse(
              {
                ok: false,
                status: "conflict",
                code: rec.code,
                error: rec.code,
              },
              409,
            );
          }
          if (rec.ok === false || rec.error) {
            return jsonResponse(rec, 400);
          }
        }
        return jsonResponse(
          {
            ok: true,
            ...(typeof result === "object" && result !== null ? (result as Record<string, unknown>) : { result }),
          },
          200,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Publication failed";
        return apiError("PUBLICATION_FAILED", msg, 500);
      }
    }

    return apiError("NOT_FOUND", "Route not found", 404);
  };
}
