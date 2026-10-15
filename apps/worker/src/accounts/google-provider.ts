import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  discovery,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  customFetch as openIdCustomFetch,
  enableNonRepudiationChecks,
  type CustomFetch,
} from 'openid-client';
import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type FetchImplementation,
} from 'jose';
import type { VerifiedGoogleIdentity } from '../../../db/src/accounts.js';
import type { AccountGoogleProvider, CompleteGoogleWebAuthorizationInput } from './types.js';

export const GOOGLE_OPENID_ISSUER = 'https://accounts.google.com';
export const GOOGLE_ID_TOKEN_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

export interface GoogleAccountProviderConfiguration {
  readonly webClientId: string;
  readonly webClientSecret: string;
  /** Google OAuth web client ID configured as the native SDK's serverClientId. */
  readonly nativeAudience: string;
  /** Optional registered native client IDs permitted as Google's `azp` presenter. */
  readonly nativeAuthorizedParties?: readonly string[];
  readonly callbackUrl: string;
  /** Test seam. Production leaves this unset and jose uses fetch against Google's fixed JWKS URL. */
  readonly jwksFetch?: FetchImplementation;
  /** Test seam for local OIDC metadata, token, and signing-key fixtures. */
  readonly oidcFetch?: CustomFetch;
}

/** Builds the maintained OpenID Connect authorization-code and native ID-token adapters. */
export async function createGoogleAccountProvider(
  configuration: GoogleAccountProviderConfiguration,
): Promise<AccountGoogleProvider> {
  validateProviderConfiguration(configuration);
  let callbackUrl: URL;
  try {
    callbackUrl = new URL(configuration.callbackUrl);
  } catch {
    throw new Error('Google account provider configuration is invalid.');
  }

  let openIdConfiguration;
  try {
    openIdConfiguration = await discovery(
      new URL(GOOGLE_OPENID_ISSUER),
      configuration.webClientId,
      configuration.webClientSecret,
      undefined,
      {
        execute: [enableNonRepudiationChecks],
        ...(configuration.oidcFetch ? { [openIdCustomFetch]: configuration.oidcFetch } : {}),
      },
    );
    if (openIdConfiguration.serverMetadata().issuer !== GOOGLE_OPENID_ISSUER) {
      throw new Error('issuer mismatch');
    }
  } catch {
    throw new Error('Google account provider is unavailable.');
  }

  const verifyNativeIdToken = createGoogleNativeTokenVerifier(
    configuration.nativeAudience,
    configuration.jwksFetch,
    configuration.nativeAuthorizedParties,
  );

  return {
    async beginWeb() {
      try {
        const state = randomState();
        const nonce = randomNonce();
        const codeVerifier = randomPKCECodeVerifier();
        const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
        const authorizationUrl = buildAuthorizationUrl(openIdConfiguration, {
          response_type: 'code',
          redirect_uri: callbackUrl.href,
          scope: 'openid email profile',
          state,
          nonce,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
        });
        return { authorizationUrl: authorizationUrl.href, state, nonce, codeVerifier };
      } catch {
        throw new Error('Google authorization could not be started.');
      }
    },

    async completeWeb(input: CompleteGoogleWebAuthorizationInput) {
      if (input.callbackUrl.origin !== callbackUrl.origin
        || input.callbackUrl.pathname !== callbackUrl.pathname
        || input.callbackUrl.searchParams.getAll('code').length !== 1
        || input.callbackUrl.searchParams.getAll('state').length !== 1
        || input.callbackUrl.searchParams.get('state') !== input.expectedState) {
        throw new Error('Google callback is invalid.');
      }
      try {
        const tokens = await authorizationCodeGrant(openIdConfiguration, input.callbackUrl, {
          pkceCodeVerifier: input.codeVerifier,
          expectedState: input.expectedState,
          expectedNonce: input.expectedNonce,
          idTokenExpected: true,
        });
        const claims = tokens.claims();
        if (!claims) throw new Error('missing claims');
        return identityFromGoogleClaims(claims as unknown as Record<string, unknown>);
      } catch {
        throw new Error('Google identity could not be verified.');
      }
    },

    verifyNativeIdToken,
  };
}

/**
 * Verifies native ID tokens against Google's fixed issuer/JWKS and the configured
 * serverClientId audience. The injectable transport exists for local signed-token tests.
 */
export function createGoogleNativeTokenVerifier(
  audience: string,
  fetcher?: FetchImplementation,
  authorizedParties: readonly string[] = [],
): (idToken: string) => Promise<VerifiedGoogleIdentity> {
  if (!isClientId(audience) || authorizedParties.length > 4
    || authorizedParties.some((party) => !isClientId(party))) {
    throw new TypeError('Google native audience configuration is invalid.');
  }
  const allowedAuthorizedParties = new Set([audience, ...authorizedParties]);
  const keyOptions = fetcher ? { [customFetch]: fetcher } : undefined;
  const keys = createRemoteJWKSet(new URL(GOOGLE_ID_TOKEN_JWKS_URL), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    ...(keyOptions ?? {}),
  });

  return async (idToken) => {
    if (typeof idToken !== 'string' || idToken.length < 20 || idToken.length > 12_000) {
      throw new Error('Google native identity could not be verified.');
    }
    try {
      const verified = await jwtVerify(idToken, keys, {
        issuer: GOOGLE_OPENID_ISSUER,
        audience,
        algorithms: ['RS256'],
        clockTolerance: 5,
      });
      const payload = verified.payload as Record<string, unknown>;
      const nowSeconds = Math.floor(Date.now() / 1_000);
      if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)
        || typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)
        || payload.iat > nowSeconds + 5
        || payload.iss !== GOOGLE_OPENID_ISSUER
        || payload.email_verified !== true) {
        throw new Error('claims mismatch');
      }
      const audiences = typeof payload.aud === 'string'
        ? [payload.aud]
        : Array.isArray(payload.aud) && payload.aud.every((item) => typeof item === 'string')
          ? payload.aud as string[]
          : [];
      const authorizedParty = payload.azp;
      if (!audiences.includes(audience)
        || (authorizedParty !== undefined
          && (typeof authorizedParty !== 'string' || !allowedAuthorizedParties.has(authorizedParty)))
        || (audiences.length > 1 && typeof authorizedParty !== 'string')) {
        throw new Error('audience mismatch');
      }
      return identityFromGoogleClaims(payload);
    } catch {
      throw new Error('Google native identity could not be verified.');
    }
  };
}

function identityFromGoogleClaims(claims: Record<string, unknown>): VerifiedGoogleIdentity {
  const issuer = claims.iss;
  const subject = claims.sub;
  const email = claims.email;
  const displayName = claims.name;
  if (issuer !== GOOGLE_OPENID_ISSUER
    || typeof subject !== 'string' || subject.length < 1 || subject.length > 255
    || typeof email !== 'string' || email.length < 3 || email.length > 320
    || claims.email_verified !== true
    || typeof displayName !== 'string' || displayName.trim().length < 1 || displayName.length > 200
    || /[\u0000-\u001f\u007f]/u.test(subject)
    || /[\u0000-\u001f\u007f]/u.test(displayName)
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new Error('Google identity claims are invalid.');
  }
  return {
    issuer,
    subject,
    email,
    emailVerified: true,
    displayName,
  };
}

function validateProviderConfiguration(configuration: GoogleAccountProviderConfiguration): void {
  if (!isClientId(configuration.webClientId)
    || typeof configuration.webClientSecret !== 'string'
    || configuration.webClientSecret.length < 1
    || configuration.webClientSecret.length > 4_096
    || !isClientId(configuration.nativeAudience)
    || (configuration.nativeAuthorizedParties !== undefined
      && (configuration.nativeAuthorizedParties.length > 4
        || configuration.nativeAuthorizedParties.some((party) => !isClientId(party))))) {
    throw new TypeError('Google account provider configuration is invalid.');
  }
  try {
    const callback = new URL(configuration.callbackUrl);
    const local = callback.protocol === 'http:'
      && (callback.hostname === 'localhost' || callback.hostname === '127.0.0.1' || callback.hostname === '[::1]');
    if ((!local && callback.protocol !== 'https:')
      || callback.username || callback.password || callback.hash
      || callback.pathname !== '/api/v1/auth/google/callback'
      || callback.search) {
      throw new Error('callback mismatch');
    }
  } catch {
    throw new TypeError('Google account provider configuration is invalid.');
  }
}

function isClientId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 8
    && value.length <= 512
    && /^[A-Za-z0-9._:-]+$/u.test(value);
}
