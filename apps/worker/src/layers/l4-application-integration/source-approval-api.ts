/**
 * FR-12 admin source approval route (TEST-GAP-02 / T10b). Governed by ADR-006 and the moderator
 * action vocabulary: `approve_source` is granted to administrators only, and it is decided by
 * authorizeModeratorAction, not by a new mechanism.
 *
 * Implements:
 * - GET  /api/v1/admin/sources                      (registry list with approval state)
 * - POST /api/v1/admin/sources/:sourceId/approval   (body: { status: "approved" | "revoked", note })
 *
 * Browser writes need the exact application Origin and the session CSRF token. Each successful write is one
 * transaction in the store: registry row, trace and audit row. Approval never grants public display on its own;
 * the public_display_granted field reports the existing permission model.
 */

import type { SourceApprovalRecord, SourceApprovalStore, SourceApprovalWriteResult } from "../../../../db/src/source-approval-store.js";
import type {
  AdminSourceApprovalItem,
  AdminSourceApprovalResponse,
  AdminSourceListResponse,
} from "../../contracts/source-approval.js";
import { evaluateSourcePermissions } from "../l1-data-knowledge/news-triage.js";
import { authorizeModeratorAction, type ModeratorDataset } from "./moderator-authorization.js";
import type { ModerationPrincipal } from "./moderation-api.js";

export const SOURCE_APPROVAL_PATH_PREFIX = "/api/v1/admin/sources";

const MAX_BODY_BYTES = 4_096;
const NOTE_MIN_LENGTH = 10;
const NOTE_MAX_LENGTH = 500;
const SOURCE_ID_MAX_LENGTH = 200;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export interface SourceApprovalApiDependencies {
  /** Resolves the browser session principal. A throw maps to 503, never to an anonymous answer. */
  readonly authenticate: (request: Request) => Promise<ModerationPrincipal | null>;
  /** Runs one unit of store work on the server-selected dataset. A throw maps to 503. */
  readonly withStore: <Result>(work: (store: SourceApprovalStore) => Promise<Result>) => Promise<Result>;
  /** Exact application origin, from trusted configuration. */
  readonly appOrigin: string;
  /** Server-selected dataset. Principals outside it are denied. */
  readonly datasetScope: ModeratorDataset;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export type SourceApprovalApiHandler = (request: Request) => Promise<Response | undefined>;

type Route =
  | { readonly kind: "list" }
  | { readonly kind: "approval"; readonly sourceId: string }
  | { readonly kind: "method"; readonly allowed: string }
  | { readonly kind: "not_found" };

export function isSourceApprovalPath(pathname: string): boolean {
  return pathname === SOURCE_APPROVAL_PATH_PREFIX || pathname.startsWith(`${SOURCE_APPROVAL_PATH_PREFIX}/`);
}

function parseRoute(pathname: string, method: string): Route | null {
  if (!isSourceApprovalPath(pathname)) return null;
  const cleanPath = pathname.replace(/\/+$/u, "");
  if (cleanPath === SOURCE_APPROVAL_PATH_PREFIX) {
    return method === "GET" ? { kind: "list" } : { kind: "method", allowed: "GET" };
  }
  const match = cleanPath.match(/^\/api\/v1\/admin\/sources\/([^/]+)\/approval$/u);
  if (!match) return { kind: "not_found" };
  let sourceId: string;
  try {
    sourceId = decodeURIComponent(match[1] ?? "");
  } catch {
    return { kind: "not_found" };
  }
  if (sourceId.trim().length === 0 || sourceId.length > SOURCE_ID_MAX_LENGTH) return { kind: "not_found" };
  return method === "POST" ? { kind: "approval", sourceId } : { kind: "method", allowed: "POST" };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function apiError(code: string, message: string, status: number): Response {
  return jsonResponse({ code, message, request_id: crypto.randomUUID() }, status);
}

function constantTimeEqualText(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

type Authorized = { readonly ok: true; readonly principal: ModerationPrincipal } | { readonly ok: false; readonly response: Response };

/** Session first, then the closed `approve_source` decision. Only an active administrator passes. */
async function authorize(request: Request, dependencies: SourceApprovalApiDependencies): Promise<Authorized> {
  let principal: ModerationPrincipal | null;
  try {
    principal = await dependencies.authenticate(request);
  } catch {
    return { ok: false, response: apiError("TEMPORARILY_UNAVAILABLE", "Source approval is not available on this service.", 503) };
  }
  if (!principal) {
    return { ok: false, response: apiError("UNAUTHORIZED", "Authentication required to manage source approval", 401) };
  }
  const datasetScope = dependencies.datasetScope;
  const decision = authorizeModeratorAction({
    principal: {
      actorId: principal.actorId,
      role: principal.role as "moderator" | "admin",
      active: principal.active,
      datasetScope: (principal.datasetScope ?? datasetScope) as ModeratorDataset,
    },
    action: "approve_source",
    targetDataset: datasetScope,
    serverSelectedDataset: datasetScope,
  });
  if (decision.decision === "allow") return { ok: true, principal };
  if (decision.reasonCode === "principal_inactive") {
    return { ok: false, response: apiError("ACCOUNT_INACTIVE", "Account is inactive", 403) };
  }
  if (decision.reasonCode === "principal_missing") {
    return { ok: false, response: apiError("UNAUTHORIZED", "Authentication required to manage source approval", 401) };
  }
  return { ok: false, response: apiError("FORBIDDEN", "Forbidden: requires an active administrator", 403) };
}

/** Exact Origin plus the session CSRF token. A principal without a session token fails closed. */
function csrfDenial(request: Request, principal: ModerationPrincipal, appOrigin: string): Response | null {
  if (request.headers.get("origin") !== appOrigin) {
    return apiError("CSRF_ORIGIN_MISMATCH", "Origin header does not match expected application origin", 403);
  }
  const expected = principal.csrfToken ?? null;
  const header = request.headers.get("x-csrf-token");
  if (expected === null || expected.length === 0 || header === null || !constantTimeEqualText(header, expected)) {
    return apiError("CSRF_TOKEN_INVALID", "Invalid or missing CSRF token", 403);
  }
  return null;
}

type WriteBody = { readonly ok: true; readonly status: "approved" | "revoked"; readonly note: string } | { readonly ok: false; readonly response: Response };

async function readWriteBody(request: Request): Promise<WriteBody> {
  const invalid = (): WriteBody => ({
    ok: false,
    response: apiError("INVALID_REQUEST", "Body must be { status: \"approved\" | \"revoked\", note: 10 to 500 characters }", 400),
  });
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return invalid();
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return invalid();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, response: apiError("INVALID_JSON", "Malformed JSON payload", 400) };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return invalid();
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !Object.hasOwn(record, "status") || !Object.hasOwn(record, "note")) return invalid();
  if (record.status !== "approved" && record.status !== "revoked") return invalid();
  if (typeof record.note !== "string") return invalid();
  const note = record.note.trim();
  if (note.length < NOTE_MIN_LENGTH || note.length > NOTE_MAX_LENGTH || CONTROL_CHARACTERS.test(note)) return invalid();
  return { ok: true, status: record.status, note };
}

/**
 * Public-display state from the existing permission model. Approval is one input; collection and a
 * public_display reuse token are the others. This route never writes any of them to grant display.
 */
function toItem(record: SourceApprovalRecord, nowIso: string): AdminSourceApprovalItem {
  const permissions = evaluateSourcePermissions(
    {
      approval_status: record.approval_status,
      auto_acquisition_enabled: record.auto_acquisition_enabled,
      registry_status: record.registry_status,
      reuse_basis: record.reuse_basis,
      reuse_license_url: record.reuse_license_url,
      reuse_scope: record.reuse_scope,
      reuse_reviewer: record.reuse_reviewer,
      reuse_reviewed_at: record.reuse_reviewed_at,
      reuse_expires_at: record.reuse_expires_at,
    },
    nowIso,
    record.source_id,
  );
  return {
    source_id: record.source_id,
    display_name: record.display_name,
    source_kind: record.source_kind,
    access_method: record.access_method,
    registry_status: record.registry_status,
    approval_status: record.approval_status,
    auto_acquisition_enabled: record.auto_acquisition_enabled,
    auto_publication_policy: record.auto_publication_policy,
    public_display_granted: permissions.publicDisplay === true,
  };
}

/**
 * Creates the admin source approval handler. It returns undefined for paths outside
 * /api/v1/admin/sources, so the Worker can keep dispatching other routes.
 */
export function createSourceApprovalApiHandler(dependencies: SourceApprovalApiDependencies): SourceApprovalApiHandler {
  const now = dependencies.now ?? (() => new Date());
  const newId = dependencies.newId ?? (() => crypto.randomUUID());

  return async function handleSourceApprovalRequest(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url, "http://localhost");
    const route = parseRoute(url.pathname, request.method);
    if (route === null) return undefined;

    if (route.kind === "method") {
      return apiError("METHOD_NOT_ALLOWED", `Method ${request.method} is not allowed. Allowed: ${route.allowed}`, 405);
    }
    if (route.kind === "not_found") {
      return apiError("NOT_FOUND", `The admin route ${url.pathname} was not found`, 404);
    }

    const authorized = await authorize(request, dependencies);
    if (!authorized.ok) return authorized.response;

    const nowIso = now().toISOString();

    if (route.kind === "list") {
      try {
        const records = await dependencies.withStore((store) => store.listSources());
        const body: AdminSourceListResponse = { sources: records.map((record) => toItem(record, nowIso)) };
        return jsonResponse(body, 200);
      } catch {
        return apiError("TEMPORARILY_UNAVAILABLE", "Source approval is not available on this service.", 503);
      }
    }

    const denial = csrfDenial(request, authorized.principal, dependencies.appOrigin);
    if (denial) return denial;

    const body = await readWriteBody(request);
    if (!body.ok) return body.response;

    const traceId = newId();
    const auditId = newId();
    let outcome: SourceApprovalWriteResult;
    try {
      outcome = await dependencies.withStore((store) => store.setApproval({
        sourceId: route.sourceId,
        status: body.status,
        note: body.note,
        actorId: authorized.principal.actorId,
        traceId,
        auditId,
        occurredAt: nowIso,
      }));
    } catch {
      return apiError("TEMPORARILY_UNAVAILABLE", "Source approval could not be recorded.", 503);
    }

    if (outcome.outcome === "not_found") {
      return apiError("SOURCE_NOT_FOUND", "The source was not found", 404);
    }
    if (outcome.outcome === "unchanged") {
      return apiError("SOURCE_APPROVAL_UNCHANGED", "The source already has this approval status", 409);
    }
    const response: AdminSourceApprovalResponse = {
      source: toItem(outcome.after, nowIso),
      previous_approval_status: outcome.before.approval_status,
      audit_id: auditId,
    };
    return jsonResponse(response, 200);
  };
}
