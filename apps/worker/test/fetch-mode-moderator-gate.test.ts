import assert from "node:assert/strict";
import test from "node:test";
import { createContextSourcesHandler } from "../src/layers/l4-application-integration/context-sources-api.js";
import { createSourcePreviewHandler } from "../src/layers/l4-application-integration/source-preview-api.js";
import {
  accountEnvironment,
  requestWithSession,
  sessionExecutor,
  unreachableExecutor,
  type AccountTestEnvironment,
} from "./support/moderator-session.js";

/**
 * NFR-04 and the owner decision: `?mode=fetch` starts an upstream acquisition, so it needs a
 * moderator or admin session. Anonymous callers and registered users get a refusal, and the
 * acquisition spy is never called. Public reads never reach a provider.
 */

const demo = { DATASET_MODE: "demo", SOURCE_PREVIEW_ENABLED: "true" } as const;
const fixedNow = Date.parse("2026-11-13T05:00:00.000Z");
const inertClock = { now: () => fixedNow, schedule: () => ({}), cancel: () => {} };

type Handler = (request: Request, env: AccountTestEnvironment) => Promise<Response>;

/** Counts every upstream attempt. Each attempt answers 500, so an allowed route still completes. */
function acquisitionSpy(): { readonly fetch: typeof fetch; readonly calls: () => number } {
  let count = 0;
  const stub = (async () => {
    count += 1;
    return new Response("upstream", { status: 500 });
  }) as typeof fetch;
  return { fetch: stub, calls: () => count };
}

interface Route {
  readonly name: string;
  readonly url: string;
  readonly make: (upstream: typeof fetch) => Handler;
}

const routes: readonly Route[] = [
  {
    name: "context-sources",
    url: "https://waspada.test/api/v1/demo/context-sources",
    make: (upstream) => createContextSourcesHandler({ fetch: upstream, clock: inertClock }),
  },
  {
    name: "source-preview",
    url: "https://waspada.test/api/v1/demo/source-preview",
    make: (upstream) => createSourcePreviewHandler({ fetch: upstream, clock: inertClock }),
  },
];

for (const route of routes) {
  test(`${route.name}: a public read never reaches upstream, signed in or not`, async () => {
    const spy = acquisitionSpy();
    const handler = route.make(spy.fetch);
    const env = accountEnvironment(demo, sessionExecutor({ role: "moderator" }));
    for (const withCookie of [false, true]) {
      const response = await handler(requestWithSession(route.url, withCookie), env);
      assert.equal(response.status, 200);
    }
    assert.equal(spy.calls(), 0);
  });

  for (const denial of [
    { label: "an anonymous caller", withCookie: false, role: "moderator", active: true, status: 401, code: "UNAUTHORIZED" },
    { label: "a registered user", withCookie: true, role: "user", active: true, status: 403, code: "FORBIDDEN" },
    { label: "a deactivated moderator", withCookie: true, role: "moderator", active: false, status: 401, code: "UNAUTHORIZED" },
  ] as const) {
    test(`${route.name}: fetch mode refuses ${denial.label} with ${denial.status} and never calls upstream`, async () => {
      const spy = acquisitionSpy();
      const handler = route.make(spy.fetch);
      const env = accountEnvironment(demo, sessionExecutor({ role: denial.role, active: denial.active }));
      const response = await handler(requestWithSession(`${route.url}?mode=fetch`, denial.withCookie), env);
      assert.equal(response.status, denial.status);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal((await response.json() as { code: string }).code, denial.code);
      assert.equal(spy.calls(), 0);
    });
  }

  for (const role of ["moderator", "admin"] as const) {
    test(`${route.name}: fetch mode is allowed for a ${role} session`, async () => {
      const spy = acquisitionSpy();
      const handler = route.make(spy.fetch);
      const env = accountEnvironment(demo, sessionExecutor({ role }));
      const response = await handler(requestWithSession(`${route.url}?mode=fetch`, true), env);
      assert.equal(response.status, 200);
      assert.ok(spy.calls() > 0, "an authorized fetch reaches the acquisition spy");
    });
  }

  test(`${route.name}: fetch mode fails closed without accounts or when the account store is down`, async () => {
    const spy = acquisitionSpy();
    const handler = route.make(spy.fetch);
    const unconfigured = await handler(
      requestWithSession(`${route.url}?mode=fetch`, true),
      accountEnvironment(demo),
    );
    assert.equal(unconfigured.status, 503);
    const unreachable = await handler(
      requestWithSession(`${route.url}?mode=fetch`, true),
      accountEnvironment(demo, unreachableExecutor()),
    );
    assert.equal(unreachable.status, 503);
    assert.equal(spy.calls(), 0);
  });
}
