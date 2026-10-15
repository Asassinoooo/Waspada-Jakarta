import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT, type FetchImplementation } from 'jose';
import type { CustomFetch } from 'openid-client';
import {
  createGoogleNativeTokenVerifier,
  GOOGLE_ID_TOKEN_JWKS_URL,
  GOOGLE_OPENID_ISSUER,
} from '../src/accounts/google-provider.js';

const audience = 'local-google-web-client.apps.googleusercontent.com';

test('native adapter verifies a locally signed Google ID token against fixed issuer, audience, and JWKS URL', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: 'local-google-key', alg: 'RS256', use: 'sig' });
  const urls: string[] = [];
  const fetcher: FetchImplementation = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' },
    });
  };
  const verify = createGoogleNativeTokenVerifier(audience, fetcher);
  const now = Math.floor(Date.now() / 1_000);
  const token = await new SignJWT({
    email: 'verified@example.test',
    email_verified: true,
    name: 'Verified Person',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'local-google-key' })
    .setIssuer(GOOGLE_OPENID_ISSUER)
    .setSubject('google-subject-1')
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);

  assert.deepEqual(await verify(token), {
    issuer: GOOGLE_OPENID_ISSUER,
    subject: 'google-subject-1',
    email: 'verified@example.test',
    emailVerified: true,
    displayName: 'Verified Person',
  });
  assert.deepEqual(urls, [GOOGLE_ID_TOKEN_JWKS_URL]);
});

test('native adapter rejects bad issuer, audience, email verification, expiry, claims, and oversized tokens', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: 'local-google-key', alg: 'RS256', use: 'sig' });
  const fetcher: FetchImplementation = async () => new Response(JSON.stringify({ keys: [jwk] }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' },
  });
  const verify = createGoogleNativeTokenVerifier(audience, fetcher);
  const androidClientId = '1234567890-android.apps.googleusercontent.com';
  const verifyAndroid = createGoogleNativeTokenVerifier(audience, fetcher, [androidClientId]);
  const now = Math.floor(Date.now() / 1_000);
  const makeToken = async (overrides: {
    issuer?: string;
    tokenAudience?: string | string[];
    emailVerified?: unknown;
    expiresAt?: number;
    displayName?: unknown;
    authorizedParty?: unknown;
  } = {}) => new SignJWT({
    email: 'verified@example.test',
    email_verified: overrides.emailVerified ?? true,
    name: overrides.displayName ?? 'Verified Person',
    ...(overrides.authorizedParty === undefined ? {} : { azp: overrides.authorizedParty }),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'local-google-key' })
    .setIssuer(overrides.issuer ?? GOOGLE_OPENID_ISSUER)
    .setSubject('google-subject-2')
    .setAudience(overrides.tokenAudience ?? audience)
    .setIssuedAt(now - 1_000)
    .setExpirationTime(overrides.expiresAt ?? now + 300)
    .sign(privateKey);

  await assert.rejects(verify(await makeToken({ issuer: 'https://attacker.example' })), /could not be verified/u);
  await assert.rejects(verify(await makeToken({ tokenAudience: 'another-client.apps.googleusercontent.com' })), /could not be verified/u);
  await assert.rejects(verify(await makeToken({
    tokenAudience: [audience, 'another-client.apps.googleusercontent.com'],
    authorizedParty: 'another-client.apps.googleusercontent.com',
  })), /could not be verified/u);
  await assert.rejects(verify(await makeToken({ authorizedParty: 123 })), /could not be verified/u);
  await assert.rejects(verify(await makeToken({ authorizedParty: androidClientId })), /could not be verified/u,
    'an Android presenter is rejected until it is explicitly configured');
  assert.equal((await verifyAndroid(await makeToken({ authorizedParty: androidClientId }))).subject, 'google-subject-2');
  await assert.rejects(verifyAndroid(await makeToken({
    tokenAudience: [audience, 'another-client.apps.googleusercontent.com'],
  })), /could not be verified/u, 'multi-audience tokens require a trusted authorized presenter');
  await assert.rejects(verify(await makeToken({ emailVerified: false })), /could not be verified/u);
  await assert.rejects(verify(await makeToken({ expiresAt: now - 120 })), /could not be verified/u);
  await assert.rejects(verify(await makeToken({ displayName: '' })), /could not be verified/u);
  await assert.rejects(verify('x'.repeat(12_001)), /could not be verified/u);
  await assert.rejects(verify('not-a-jwt-token'), /could not be verified/u);
});

test('browser code flow verifies nonce and ID-token signature using local OIDC and JWKS fixtures', async () => {
  const trusted = await generateKeyPair('RS256');
  const untrusted = await generateKeyPair('RS256');
  const jwk = await exportJWK(trusted.publicKey);
  Object.assign(jwk, { kid: 'local-google-web-key', alg: 'RS256', use: 'sig' });
  let nextIdToken = '';
  const visited: string[] = [];
  const tokenRequestBodies: string[] = [];
  const callbackUrl = 'https://waspada.example/api/v1/auth/google/callback';
  const oidcFetch: CustomFetch = async (url, options) => {
    visited.push(url);
    if (url === `${GOOGLE_OPENID_ISSUER}/.well-known/openid-configuration`) {
      return jsonResponse({
        issuer: GOOGLE_OPENID_ISSUER,
        authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        token_endpoint: 'https://oauth2.googleapis.com/token',
        jwks_uri: GOOGLE_ID_TOKEN_JWKS_URL,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      tokenRequestBodies.push(String(options.body));
      return jsonResponse({
        access_token: 'synthetic-access-token',
        expires_in: 300,
        token_type: 'Bearer',
        id_token: nextIdToken,
      });
    }
    if (url === GOOGLE_ID_TOKEN_JWKS_URL) {
      return jsonResponse({ keys: [jwk] });
    }
    throw new Error(`Unexpected mocked URL: ${url}`);
  };

  const { createGoogleAccountProvider } = await import('../src/accounts/google-provider.js');
  const provider = await createGoogleAccountProvider({
    webClientId: audience,
    webClientSecret: 'local-test-client-secret',
    nativeAudience: audience,
    callbackUrl,
    oidcFetch,
  });

  const completeWith = async (
    signingKey: CryptoKey,
    nonceTransform: (nonce: string) => string = (nonce) => nonce,
  ) => {
    const authorization = await provider.beginWeb();
    const callback = new URL(callbackUrl);
    callback.searchParams.set('code', `local-code-${tokenRequestBodies.length + 1}`);
    callback.searchParams.set('state', authorization.state);
    nextIdToken = await new SignJWT({
      email: 'web@example.test',
      email_verified: true,
      name: 'Browser User',
      nonce: nonceTransform(authorization.nonce),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'local-google-web-key' })
      .setIssuer(GOOGLE_OPENID_ISSUER)
      .setSubject('web-subject')
      .setAudience(audience)
      .setIssuedAt(Math.floor(Date.now() / 1_000))
      .setExpirationTime(Math.floor(Date.now() / 1_000) + 300)
      .sign(signingKey);
    return provider.completeWeb({
      callbackUrl: callback,
      codeVerifier: authorization.codeVerifier,
      expectedState: authorization.state,
      expectedNonce: authorization.nonce,
    });
  };

  assert.deepEqual(await completeWith(trusted.privateKey), {
    issuer: GOOGLE_OPENID_ISSUER,
    subject: 'web-subject',
    email: 'web@example.test',
    emailVerified: true,
    displayName: 'Browser User',
  });
  await assert.rejects(completeWith(untrusted.privateKey), /could not be verified/u,
    'a valid claims payload with an untrusted signature must fail');
  await assert.rejects(completeWith(trusted.privateKey, () => 'wrong-nonce'), /could not be verified/u,
    'a valid signature with the wrong nonce must fail');
  assert.equal(tokenRequestBodies.length, 3);
  assert.ok(tokenRequestBodies[0]?.includes('code_verifier='));
  assert.ok(visited.every((url) => [
    `${GOOGLE_OPENID_ISSUER}/.well-known/openid-configuration`,
    'https://oauth2.googleapis.com/token',
    GOOGLE_ID_TOKEN_JWKS_URL,
  ].includes(url)), 'adapter tests only use local fixtures behind the injected transport');
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' },
  });
}
