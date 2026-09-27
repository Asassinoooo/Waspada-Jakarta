import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeModeratorAction,
  MODERATOR_ACTIONS,
  type ModeratorAuthorizationInput,
  type ModeratorDataset,
  type ModeratorRole,
  type ServerResolvedModeratorPrincipal,
} from "../src/layers/l4-application-integration/moderator-authorization.js";

const syntheticModerator: ServerResolvedModeratorPrincipal = {
  actorId: "moderator-synthetic-01",
  role: "moderator",
  active: true,
  datasetScope: "synthetic",
};

function request(
  role: ModeratorRole,
  action: ModeratorAuthorizationInput["action"],
  overrides: Partial<ModeratorAuthorizationInput> = {},
): ModeratorAuthorizationInput {
  return {
    principal: { ...syntheticModerator, role },
    action,
    targetDataset: "synthetic",
    serverSelectedDataset: "synthetic",
    ...overrides,
  };
}

test("moderator and admin receive exactly their documented action permissions", () => {
  const moderatorAllowed = new Set([
    "review_evidence",
    "approve_publication",
    "submit_correction",
    "retract_information",
  ]);

  for (const action of MODERATOR_ACTIONS) {
    const moderatorResult = authorizeModeratorAction(request("moderator", action));
    assert.deepEqual(
      moderatorResult,
      moderatorAllowed.has(action)
        ? { decision: "allow", reasonCode: "authorized" }
        : { decision: "deny", reasonCode: "role_action_denied" },
      `moderator action ${action}`,
    );

    assert.deepEqual(
      authorizeModeratorAction(request("admin", action)),
      { decision: "allow", reasonCode: "authorized" },
      `admin action ${action}`,
    );
  }
});

test("missing, inactive, and malformed principals fail closed with bounded results", () => {
  const base = request("moderator", "review_evidence");
  const principalWithDisabledAccount = { ...syntheticModerator, active: false };

  assert.deepEqual(
    authorizeModeratorAction({ ...base, principal: null }),
    { decision: "deny", reasonCode: "principal_missing" },
  );
  assert.deepEqual(
    authorizeModeratorAction({ ...base, principal: principalWithDisabledAccount }),
    { decision: "deny", reasonCode: "principal_inactive" },
  );
  assert.deepEqual(
    authorizeModeratorAction({ ...base, principal: { ...syntheticModerator, actorId: " " } }),
    { decision: "deny", reasonCode: "principal_malformed" },
  );
  assert.deepEqual(
    authorizeModeratorAction({ ...base, principal: { ...syntheticModerator, active: "true" } } as unknown as ModeratorAuthorizationInput),
    { decision: "deny", reasonCode: "principal_malformed" },
  );
  assert.deepEqual(
    authorizeModeratorAction({ ...base, principal: { ...syntheticModerator, unexpected: "private" } } as unknown as ModeratorAuthorizationInput),
    { decision: "deny", reasonCode: "principal_malformed" },
  );
});

test("unknown roles, actions, and dataset values fail closed", () => {
  const base = request("moderator", "review_evidence");

  assert.deepEqual(
    authorizeModeratorAction({ ...base, principal: { ...syntheticModerator, role: "owner" } } as unknown as ModeratorAuthorizationInput),
    { decision: "deny", reasonCode: "unknown_role" },
  );
  assert.deepEqual(
    authorizeModeratorAction({ ...base, action: "delete_audit_log" } as unknown as ModeratorAuthorizationInput),
    { decision: "deny", reasonCode: "unknown_action" },
  );
  assert.deepEqual(
    authorizeModeratorAction({ ...base, targetDataset: "staging" } as unknown as ModeratorAuthorizationInput),
    { decision: "deny", reasonCode: "dataset_invalid" },
  );
  assert.deepEqual(
    authorizeModeratorAction({ ...base, principal: { ...syntheticModerator, datasetScope: "staging" } } as unknown as ModeratorAuthorizationInput),
    { decision: "deny", reasonCode: "dataset_invalid" },
  );
});

test("scope must match both the requested target and trusted server selection", () => {
  const mismatches: readonly [ModeratorDataset, ModeratorDataset, ServerResolvedModeratorPrincipal][] = [
    ["historical", "synthetic", syntheticModerator],
    ["synthetic", "historical", syntheticModerator],
    ["historical", "historical", syntheticModerator],
  ];

  for (const [targetDataset, serverSelectedDataset, principal] of mismatches) {
    assert.deepEqual(
      authorizeModeratorAction({
        principal,
        action: "review_evidence",
        targetDataset,
        serverSelectedDataset,
      }),
      { decision: "deny", reasonCode: "dataset_scope_mismatch" },
    );
  }
});

test("results are deterministic and disclose no principal or request data", () => {
  const privateActorId = "moderator-private-actor-7731";
  const input = request("moderator", "approve_publication", {
    principal: { ...syntheticModerator, actorId: privateActorId },
  });

  const first = authorizeModeratorAction(input);
  const second = authorizeModeratorAction(input);

  assert.deepEqual(first, second);
  assert.deepEqual(first, { decision: "allow", reasonCode: "authorized" });
  assert.equal(JSON.stringify(first).includes(privateActorId), false);
  assert.deepEqual(
    authorizeModeratorAction({ ...input, targetDataset: "historical" }),
    { decision: "deny", reasonCode: "dataset_scope_mismatch" },
  );
});

test("unknown request properties and non-record input fail closed", () => {
  const base = request("admin", "approve_source");

  assert.deepEqual(
    authorizeModeratorAction({ ...base, clientRole: "admin" } as unknown as ModeratorAuthorizationInput),
    { decision: "deny", reasonCode: "request_malformed" },
  );
  assert.deepEqual(
    authorizeModeratorAction(null as unknown as ModeratorAuthorizationInput),
    { decision: "deny", reasonCode: "request_malformed" },
  );
});
