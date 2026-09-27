/** Closed action vocabulary governed by ADR-006 and MOD-01-AUTHZ-POLICY-CORE. */
export const MODERATOR_ACTIONS = [
  "review_evidence",
  "approve_publication",
  "submit_correction",
  "retract_information",
  "approve_source",
  "manage_moderator_access",
] as const;

export type ModeratorAction = (typeof MODERATOR_ACTIONS)[number];

export const MODERATOR_ROLES = ["moderator", "admin"] as const;

export type ModeratorRole = (typeof MODERATOR_ROLES)[number];

export const MODERATOR_DATASETS = ["live", "historical", "synthetic"] as const;

export type ModeratorDataset = (typeof MODERATOR_DATASETS)[number];

/**
 * A principal that a future trusted authentication boundary has already
 * resolved from server-side account state. Request fields cannot establish it.
 */
export interface ServerResolvedModeratorPrincipal {
  readonly actorId: string;
  readonly role: ModeratorRole;
  readonly active: boolean;
  readonly datasetScope: ModeratorDataset;
}

/**
 * The target is supplied by the server-side operation; serverSelectedDataset
 * must come from trusted deployment configuration, never a request parameter.
 */
export interface ModeratorAuthorizationInput {
  readonly principal: ServerResolvedModeratorPrincipal | null;
  readonly action: ModeratorAction;
  readonly targetDataset: ModeratorDataset;
  readonly serverSelectedDataset: ModeratorDataset;
}

export type ModeratorAuthorizationReasonCode =
  | "authorized"
  | "request_malformed"
  | "principal_missing"
  | "principal_malformed"
  | "principal_inactive"
  | "unknown_role"
  | "unknown_action"
  | "dataset_invalid"
  | "dataset_scope_mismatch"
  | "role_action_denied";

export type ModeratorAuthorizationResult =
  | {
      readonly decision: "allow";
      readonly reasonCode: "authorized";
    }
  | {
      readonly decision: "deny";
      readonly reasonCode: Exclude<ModeratorAuthorizationReasonCode, "authorized">;
    };

const ALLOW: ModeratorAuthorizationResult = Object.freeze({
  decision: "allow",
  reasonCode: "authorized",
});

function deny(
  reasonCode: Exclude<ModeratorAuthorizationReasonCode, "authorized">,
): ModeratorAuthorizationResult {
  return { decision: "deny", reasonCode };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isModeratorAction(value: unknown): value is ModeratorAction {
  return typeof value === "string" && (MODERATOR_ACTIONS as readonly string[]).includes(value);
}

function isModeratorRole(value: unknown): value is ModeratorRole {
  return typeof value === "string" && (MODERATOR_ROLES as readonly string[]).includes(value);
}

function isModeratorDataset(value: unknown): value is ModeratorDataset {
  return typeof value === "string" && (MODERATOR_DATASETS as readonly string[]).includes(value);
}

function isValidActorId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function roleCanPerform(role: ModeratorRole, action: ModeratorAction): boolean {
  if (role === "admin") return true;

  switch (action) {
    case "review_evidence":
    case "approve_publication":
    case "submit_correction":
    case "retract_information":
      return true;
    case "approve_source":
    case "manage_moderator_access":
      return false;
  }
}

/**
 * Decide whether an already-resolved active principal may attempt one
 * moderation action in the server-selected dataset. This does not assess
 * evidence, authorize a publication result, or write data.
 */
export function authorizeModeratorAction(
  input: ModeratorAuthorizationInput,
): ModeratorAuthorizationResult {
  try {
    if (!isRecord(input)) return deny("request_malformed");

    if (!Object.hasOwn(input, "principal")) return deny("principal_missing");
    if (!hasExactKeys(input, ["principal", "action", "targetDataset", "serverSelectedDataset"])) {
      return deny("request_malformed");
    }

    if (!isModeratorAction(input.action)) return deny("unknown_action");
    if (!isModeratorDataset(input.targetDataset) || !isModeratorDataset(input.serverSelectedDataset)) {
      return deny("dataset_invalid");
    }

    if (input.principal === null || input.principal === undefined) return deny("principal_missing");
    if (!isRecord(input.principal)
      || !hasExactKeys(input.principal, ["actorId", "role", "active", "datasetScope"])) {
      return deny("principal_malformed");
    }

    if (!isValidActorId(input.principal.actorId)) return deny("principal_malformed");
    if (!isModeratorRole(input.principal.role)) return deny("unknown_role");
    if (typeof input.principal.active !== "boolean") return deny("principal_malformed");
    if (!input.principal.active) return deny("principal_inactive");
    if (!isModeratorDataset(input.principal.datasetScope)) return deny("dataset_invalid");

    if (input.targetDataset !== input.serverSelectedDataset
      || input.principal.datasetScope !== input.targetDataset
      || input.principal.datasetScope !== input.serverSelectedDataset) {
      return deny("dataset_scope_mismatch");
    }

    if (!roleCanPerform(input.principal.role, input.action)) return deny("role_action_denied");

    return ALLOW;
  } catch {
    // Malformed objects must not leak their contents through errors or results.
    return deny("request_malformed");
  }
}
