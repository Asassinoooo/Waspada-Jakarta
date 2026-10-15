import assert from 'node:assert/strict';
import test from 'node:test';
import { createSyntheticAccountProvider, DEMO_IDENTITIES } from './demo-provider.js';

test('Node-only synthetic consent is labelled, finite, browser-state/PKCE/nonce bound and single-use', async () => {
  const demo = createSyntheticAccountProvider('http://127.0.0.1:5173');
  const authorization = await demo.provider.beginWeb();
  const url = new URL(authorization.authorizationUrl);
  const consent = await demo.consent(new Request(url));
  assert.equal(consent?.status, 200);
  const html = await consent!.text();
  assert.match(html, /akun rekaan, bukan Google/);
  assert.equal(html.includes(authorization.codeVerifier), false);
  assert.equal(html.includes(authorization.nonce), false);
  const invalid = new URL(url);
  invalid.searchParams.set('identity', 'become-arbitrary-admin');
  assert.equal((await demo.consent(new Request(invalid)))?.status, 400);
  url.searchParams.set('identity', DEMO_IDENTITIES[0]!.identity.subject);
  const accepted = await demo.consent(new Request(url));
  assert.equal(accepted?.status, 303);
  const callback = new URL(accepted!.headers.get('location')!);
  const input = { callbackUrl: callback, codeVerifier: authorization.codeVerifier, expectedState: authorization.state, expectedNonce: authorization.nonce };
  assert.deepEqual(await demo.provider.completeWeb(input), DEMO_IDENTITIES[0]!.identity);
  await assert.rejects(demo.provider.completeWeb(input));
  assert.equal((await demo.consent(new Request(url)))?.status, 400);
  await assert.rejects(demo.provider.verifyNativeIdToken('synthetic-mobile-token'));
  assert.throws(() => createSyntheticAccountProvider('https://live.example'));
});

test('wrong nonce burns a synthetic code instead of accepting or replaying it', async () => {
  const demo = createSyntheticAccountProvider('http://127.0.0.1:5173');
  const authorization = await demo.provider.beginWeb();
  const url = new URL(authorization.authorizationUrl);
  url.searchParams.set('identity', DEMO_IDENTITIES[1]!.identity.subject);
  const response = await demo.consent(new Request(url));
  const callbackUrl = new URL(response!.headers.get('location')!);
  const input = { callbackUrl, codeVerifier: authorization.codeVerifier, expectedState: authorization.state, expectedNonce: 'wrong-nonce' };
  await assert.rejects(demo.provider.completeWeb(input));
  await assert.rejects(demo.provider.completeWeb({ ...input, expectedNonce: authorization.nonce }));
});
