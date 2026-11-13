import type {
  AdminSourceApprovalItem,
  AdminSourceApprovalResponse,
  AdminSourceApprovalStatus,
  AdminSourceListResponse,
} from "@waspada/worker/source-approval-contracts";
import type { SessionEnvelope } from "@waspada/worker/account-contracts";

/** FR-12 admin source approval client. Same-origin only; the session CSRF token is sent on every write. */

export class SourceApprovalHttpError extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super("Source approval request failed with status " + status);
    this.name = "SourceApprovalHttpError";
  }
}

export class SourceApprovalPayloadError extends Error {
  constructor() {
    super("Source approval response could not be safely read");
    this.name = "SourceApprovalPayloadError";
  }
}

export interface SourceApprovalClient {
  listSources(options?: { signal?: AbortSignal }): Promise<AdminSourceListResponse>;
  setApproval(sourceId: string, status: AdminSourceApprovalStatus, note: string, csrfToken: string): Promise<AdminSourceApprovalResponse>;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const SOURCE_APPROVAL_NOTE_MIN = 10;
export const SOURCE_APPROVAL_NOTE_MAX = 500;
const MAX_LIST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_ID_LENGTH = 200;
const MAX_CODE_LENGTH = 64;

const SOURCE_KEYS = [
  "source_id",
  "display_name",
  "source_kind",
  "access_method",
  "registry_status",
  "approval_status",
  "auto_acquisition_enabled",
  "auto_publication_policy",
  "public_display_granted",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isShortText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function parseSource(value: unknown): AdminSourceApprovalItem {
  if (!isRecord(value) || !hasExactKeys(value, SOURCE_KEYS)) throw new SourceApprovalPayloadError();
  if (
    !isShortText(value.source_id, MAX_ID_LENGTH) ||
    !isShortText(value.display_name, 200) ||
    !isShortText(value.source_kind, 64) ||
    !isShortText(value.access_method, 64) ||
    !isShortText(value.registry_status, 64) ||
    !isShortText(value.approval_status, 64) ||
    typeof value.auto_acquisition_enabled !== "boolean" ||
    !isShortText(value.auto_publication_policy, 64) ||
    typeof value.public_display_granted !== "boolean"
  ) {
    throw new SourceApprovalPayloadError();
  }
  return value as unknown as AdminSourceApprovalItem;
}

function parseList(value: unknown): AdminSourceListResponse {
  if (!isRecord(value) || !hasExactKeys(value, ["sources"]) || !Array.isArray(value.sources) || value.sources.length > 200) {
    throw new SourceApprovalPayloadError();
  }
  const sources = value.sources.map(parseSource);
  if (new Set(sources.map((source) => source.source_id)).size !== sources.length) throw new SourceApprovalPayloadError();
  return { sources };
}

function parseApproval(value: unknown): AdminSourceApprovalResponse {
  if (!isRecord(value) || !hasExactKeys(value, ["source", "previous_approval_status", "audit_id"])) {
    throw new SourceApprovalPayloadError();
  }
  if (!isShortText(value.previous_approval_status, 64) || !isShortText(value.audit_id, 200)) {
    throw new SourceApprovalPayloadError();
  }
  return { source: parseSource(value.source), previous_approval_status: value.previous_approval_status, audit_id: value.audit_id };
}

/** The note the server accepts: 10 to 500 characters after trimming. Returns a Bahasa Indonesia message, or null. */
export function sourceApprovalNoteError(note: string): string | null {
  const length = note.trim().length;
  if (length < SOURCE_APPROVAL_NOTE_MIN) return `Catatan minimal ${SOURCE_APPROVAL_NOTE_MIN} karakter.`;
  if (length > SOURCE_APPROVAL_NOTE_MAX) return `Catatan maksimal ${SOURCE_APPROVAL_NOTE_MAX} karakter.`;
  return null;
}

/** Approval controls only for an active administrator with a session CSRF token. Moderators read the list in the workspace but cannot change it. */
export function canManageSourceApprovals(session: SessionEnvelope): boolean {
  const user = session.user;
  return session.status === "authenticated"
    && user !== null
    && user.active
    && user.role === "admin"
    && typeof session.csrf_token === "string"
    && session.csrf_token.length >= 16;
}

async function readBounded(response: Response, maximumBytes: number): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new SourceApprovalPayloadError();
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maximumBytes) throw new SourceApprovalPayloadError();
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) throw new SourceApprovalPayloadError();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SourceApprovalPayloadError();
  }
}

async function errorFor(response: Response): Promise<SourceApprovalHttpError> {
  let code: string | null = null;
  try {
    const body = await response.json() as unknown;
    if (isRecord(body) && typeof body.code === "string" && body.code.length <= MAX_CODE_LENGTH) code = body.code;
  } catch {
    code = null;
  }
  return new SourceApprovalHttpError(response.status, code);
}

export function createSourceApprovalClient(fetcher: FetchLike = (input, init) => fetch(input, init)): SourceApprovalClient {
  return {
    async listSources(options = {}) {
      const response = await fetcher("/api/v1/admin/sources", {
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!response.ok) throw await errorFor(response);
      return parseList(await readBounded(response, MAX_LIST_BYTES));
    },

    async setApproval(sourceId, status, note, csrfToken) {
      if (typeof sourceId !== "string" || sourceId.length < 1 || sourceId.length > MAX_ID_LENGTH) throw new SourceApprovalPayloadError();
      if (status !== "approved" && status !== "revoked") throw new SourceApprovalPayloadError();
      if (typeof csrfToken !== "string" || csrfToken.length < 16 || csrfToken.length > 512) throw new SourceApprovalPayloadError();
      if (sourceApprovalNoteError(note) !== null) throw new SourceApprovalPayloadError();

      const response = await fetcher("/api/v1/admin/sources/" + encodeURIComponent(sourceId) + "/approval", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        body: JSON.stringify({ status, note: note.trim() }),
      });
      if (!response.ok) throw await errorFor(response);
      return parseApproval(await readBounded(response, MAX_RESPONSE_BYTES));
    },
  };
}

export const sourceApprovalClient = createSourceApprovalClient();
