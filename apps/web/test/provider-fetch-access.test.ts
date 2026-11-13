import assert from "node:assert/strict";
import test from "node:test";
import type { AccountUser, SessionEnvelope } from "@waspada/worker/account-contracts";
import { ContextSourcesHttpError } from "../src/context-sources-client.js";
import {
  providerFetchAllowed,
  providerFetchRefusalNotice,
  requestModeAllowed,
} from "../src/provider-fetch-access.js";
import { SourcePreviewHttpError } from "../src/source-preview-client.js";

/**
 * Provider fetch (`?mode=fetch`) starts an upstream acquisition, so the server allows it only to an
 * active moderator or admin. The web app decides the same way: a visitor sees no fetch control and
 * sends no fetch-mode request.
 */

function user(role: AccountUser["role"], active = true): AccountUser {
  return {
    id: "7f1d0c5e-2b1a-4c6e-9d3f-5a8b7c6d5e4f",
    display_name: "Pengguna uji",
    email: null,
    role,
    active,
    onboarding_version: 1,
    onboarding_completed_at: "2026-11-01T00:00:00.000Z",
    version: 1,
  };
}

function signedIn(account: AccountUser): SessionEnvelope {
  return {
    version: "account-v1",
    status: "authenticated",
    password_login_available: true,
    registration_available: true,
    csrf_token: "c".repeat(43),
    user: account,
  };
}

const anonymous: SessionEnvelope = {
  version: "account-v1",
  status: "anonymous",
  password_login_available: true,
  registration_available: true,
  csrf_token: null,
  user: null,
};

test("provider fetch is open only to an active moderator or admin session", () => {
  assert.equal(providerFetchAllowed(null), false, "unknown session");
  assert.equal(providerFetchAllowed(anonymous), false, "anonymous visitor");
  assert.equal(providerFetchAllowed(signedIn(user("user"))), false, "registered user");
  assert.equal(providerFetchAllowed(signedIn(user("moderator"))), true, "active moderator");
  assert.equal(providerFetchAllowed(signedIn(user("admin"))), true, "active admin");
  assert.equal(providerFetchAllowed(signedIn(user("moderator", false))), false, "deactivated moderator");
  assert.equal(providerFetchAllowed(signedIn(user("admin", false))), false, "deactivated admin");
});

test("a fetch-mode request is dropped without moderator access, and other modes always pass", () => {
  assert.equal(requestModeAllowed("fetch", false), null);
  assert.equal(requestModeAllowed("fetch", true), "fetch");
  assert.equal(requestModeAllowed("local", false), "local");
  assert.equal(requestModeAllowed("snapshot", false), "snapshot");
});

test("a refused provider fetch (401 or 403) shows a short Bahasa notice, other failures show none", () => {
  const contextNotice = providerFetchRefusalNotice(new ContextSourcesHttpError(401));
  const sourceNotice = providerFetchRefusalNotice(new SourcePreviewHttpError(403));
  assert.ok(contextNotice !== null);
  assert.ok(sourceNotice !== null);
  assert.match(contextNotice, /moderator atau admin/u);
  assert.equal(sourceNotice, contextNotice, "both sources share one notice");
  assert.equal(providerFetchRefusalNotice(new ContextSourcesHttpError(500)), null);
  assert.equal(providerFetchRefusalNotice(new SourcePreviewHttpError(503)), null);
  assert.equal(providerFetchRefusalNotice(new Error("network")), null);
});
