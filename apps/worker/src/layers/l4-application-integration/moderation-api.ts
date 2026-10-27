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

// ============================================================================
// Frozen Contract Types
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
  readonly incident_type: "flood" | "fire" | "accident" | "tree_fall" | "crime" | "weather";
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly event_time: {
    readonly precision: "exact" | "date" | "range" | "unknown";
    readonly value: string;
  };
  readonly location_label: string;
  readonly coordinates: readonly [longitude: number, latitude: number] | null;
  readonly claims: readonly {
    readonly claim_id: string;
    readonly claim_text: string;
    readonly evidence_label: "under_review";
    readonly support_assessment: "supported";
    readonly quote_text: string;
    readonly evidence_ref_id: string;
  }[];
  readonly proposed_at: string;
}

/** L4 Moderation Frozen Contract: ModeratorDecisionCommand */
export interface ModeratorDecisionCommand {
  readonly proposal_id: string;
  readonly action: "publish" | "reject" | "investigate";
  readonly evidence_label: "attributed_report" | "crowdsourced_observation";
  readonly reason?: string;
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
  readonly accountStore?: AccountStore;
  readonly authenticate?: (request: Request) => Promise<ModerationPrincipal | null>;
  readonly principal?: ModerationPrincipal | null;
  readonly listPendingProposals?: () => Promise<readonly EventProposalDto[]>;
  readonly getProposalDetail?: (proposalId: string) => Promise<ModerationProposalDetail | null>;
  readonly proposals?: readonly EventProposalDto[];
  readonly chunks?:
    | ReadonlyMap<string, readonly StoredEvidenceChunk[]>
    | Record<string, readonly StoredEvidenceChunk[]>;
  readonly buildPublicationInput?: (
    proposalId: string,
    command: ModeratorDecisionCommand,
    principal: ModerationPrincipal,
  ) => Promise<unknown> | unknown;
  readonly appOrigin?: string;
  readonly cookieMode?: AccountCookieMode;
  readonly expectedCsrfToken?: string;
  readonly csrfProtection?: boolean;
  readonly now?: () => number;
}

export type ModerationApiHandler = (request: Request) => Promise<Response | undefined>;

// ============================================================================
// Constants & Utilities
// ============================================================================

const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;

function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return rawValue.join("=");
  }
  return null;
}

function parseBearer(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return null;
  const match = /^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/iu.exec(authHeader.trim());
  return match?.[1] ?? null;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeTextEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
}

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
    const bearer = parseBearer(request);
    let rawToken: string | null = null;
    let channel: "web" | "mobile" = "mobile";
    if (bearer !== null) {
      if (!OPAQUE_TOKEN_PATTERN.test(bearer)) return null;
      rawToken = bearer;
      channel = "mobile";
    } else {
      const cookieName =
        dependencies.cookieMode === "loopback"
          ? "waspada_session"
          : "__Host-waspada_session";
      const cookieToken = readCookie(request, cookieName);
      if (!cookieToken || !OPAQUE_TOKEN_PATTERN.test(cookieToken)) return null;
      rawToken = cookieToken;
      channel = "web";
    }
    const now = dependencies.now ? dependencies.now() : Date.now();
    const tokenSha256 = await sha256(rawToken);
    const session = await dependencies.accountStore.readSession(
      tokenSha256,
      new Date(now).toISOString(),
    );
    if (!session) return null;
    return {
      actorId: session.account.id,
      role: session.account.role,
      active: session.account.active,
      csrfToken: session.csrfToken,
      channel: session.channel ?? channel,
    };
  }
  if (dependencies.principal !== undefined) {
    return dependencies.principal;
  }
  return null;
}

function checkAuthorization(
  principal: ModerationPrincipal | null,
): { readonly authorized: true; readonly principal: ModerationPrincipal } | {
  readonly authorized: false;
  readonly status: number;
  readonly code: string;
  readonly message: string;
} {
  if (!principal) {
    return {
      authorized: false,
      status: 401,
      code: "UNAUTHORIZED",
      message: "Authentication required to access moderation endpoints",
    };
  }
  if (!principal.active) {
    return {
      authorized: false,
      status: 403,
      code: "ACCOUNT_INACTIVE",
      message: "Account is inactive",
    };
  }
  if (principal.role !== "moderator" && principal.role !== "admin") {
    return {
      authorized: false,
      status: 403,
      code: "FORBIDDEN",
      message: "Forbidden: requires active user with moderator or admin role",
    };
  }
  return { authorized: true, principal };
}

function checkCsrf(
  request: Request,
  principal: ModerationPrincipal,
  dependencies: ModerationApiDependencies,
): { readonly valid: true } | {
  readonly valid: false;
  readonly status: number;
  readonly code: string;
  readonly message: string;
} {
  if (dependencies.csrfProtection === false) {
    return { valid: true };
  }
  if (dependencies.appOrigin && request.headers.has("origin")) {
    const origin = request.headers.get("origin");
    if (origin !== dependencies.appOrigin) {
      return {
        valid: false,
        status: 403,
        code: "CSRF_ORIGIN_MISMATCH",
        message: "Origin header does not match expected application origin",
      };
    }
  }
  const expectedCsrfToken = principal.csrfToken ?? dependencies.expectedCsrfToken;
  const csrfHeader = request.headers.get("x-csrf-token");
  if (expectedCsrfToken) {
    if (!csrfHeader || !constantTimeTextEqual(csrfHeader, expectedCsrfToken)) {
      return {
        valid: false,
        status: 403,
        code: "CSRF_TOKEN_INVALID",
        message: "Invalid or missing CSRF token",
      };
    }
  } else {
    if (!csrfHeader || csrfHeader.trim().length === 0) {
      return {
        valid: false,
        status: 403,
        code: "CSRF_TOKEN_INVALID",
        message: "Missing x-csrf-token header",
      };
    }
  }
  return { valid: true };
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

    // Authentication and role authorization required on all moderation endpoints
    const principal = await resolvePrincipal(request, dependencies);
    const authResult = checkAuthorization(principal);
    if (!authResult.authorized) {
      return apiError(authResult.code, authResult.message, authResult.status);
    }
    const currentPrincipal = authResult.principal;

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

      const decisionCommand: ModeratorDecisionCommand = {
        proposal_id: route.proposalId,
        action: (body.action as ModeratorDecisionCommand["action"]) ?? "publish",
        evidence_label:
          (body.evidence_label as ModeratorDecisionCommand["evidence_label"]) ?? "attributed_report",
        reason: typeof body.reason === "string" ? body.reason : undefined,
      };

      let publishInput: unknown;
      if (dependencies.buildPublicationInput) {
        publishInput = await dependencies.buildPublicationInput(
          route.proposalId,
          decisionCommand,
          currentPrincipal,
        );
      } else if (body.policyInput && body.eventDraft) {
        publishInput = { ...body, proposalId: route.proposalId };
      } else {
        publishInput = {
          proposalId: route.proposalId,
          proposal_id: route.proposalId,
          actorId: currentPrincipal.actorId,
          action: decisionCommand.action,
          evidence_label: decisionCommand.evidence_label,
          reason: decisionCommand.reason,
          decision: decisionCommand,
          command: decisionCommand,
          ...body,
        };
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
