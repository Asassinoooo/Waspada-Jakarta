import { randomBytes } from 'node:crypto';
import type { AccountGoogleProvider } from '../../apps/worker/src/accounts/index.js';
import type { VerifiedGoogleIdentity } from '../../apps/db/src/accounts.js';
import type { AccountRole } from '../../apps/worker/src/contracts/accounts.js';

export const DEMO_IDENTITIES: readonly { identity: VerifiedGoogleIdentity; role: AccountRole }[] = [
  { identity: { issuer: 'https://accounts.google.com', subject: 'synthetic-account-resident', email: 'pengguna@accounts.demo.invalid', displayName: 'Pengguna Contoh', emailVerified: true }, role: 'user' },
  { identity: { issuer: 'https://accounts.google.com', subject: 'synthetic-account-moderator', email: 'moderator@accounts.demo.invalid', displayName: 'Moderator Contoh', emailVerified: true }, role: 'moderator' },
  { identity: { issuer: 'https://accounts.google.com', subject: 'synthetic-account-admin', email: 'admin@accounts.demo.invalid', displayName: 'Admin Contoh', emailVerified: true }, role: 'admin' },
];
const token = () => randomBytes(32).toString('base64url');

/** Explicit Node-only fixture provider. Never imported by the Worker or Flutter. */
export function createSyntheticAccountProvider(appOrigin: string): {
  provider: AccountGoogleProvider;
  consent(request: Request): Promise<Response | undefined>;
} {
  if (!['http://127.0.0.1:5173', 'http://localhost:5173'].includes(appOrigin)) throw new Error('invalid_demo_origin');
  type Attempt = { nonce: string; verifier: string; expires: number };
  type Code = Attempt & { state: string; identity: VerifiedGoogleIdentity };
  const attempts = new Map<string, Attempt>();
  const codes = new Map<string, Code>();
  const cleanup = () => {
    for (const map of [attempts, codes]) {
      for (const [key, value] of map) if (value.expires < Date.now()) map.delete(key);
      while (map.size > 100) map.delete(map.keys().next().value!);
    }
  };
  const provider: AccountGoogleProvider = {
    async beginWeb() {
      cleanup();
      const state = token(); const nonce = token(); const codeVerifier = token();
      attempts.set(state, { nonce, verifier: codeVerifier, expires: Date.now() + 5 * 60_000 });
      const url = new URL('/api/v1/auth/demo/consent', appOrigin);
      url.searchParams.set('state', state);
      return { authorizationUrl: url.href, state, nonce, codeVerifier };
    },
    async completeWeb({ callbackUrl, codeVerifier, expectedState, expectedNonce }) {
      cleanup();
      const code = callbackUrl.searchParams.get('code') ?? '';
      const proof = codes.get(code);
      codes.delete(code);
      if (!proof || proof.state !== expectedState || proof.nonce !== expectedNonce || proof.verifier !== codeVerifier
        || callbackUrl.searchParams.get('state') !== expectedState) throw new Error('invalid_demo_authorization');
      return proof.identity;
    },
    async verifyNativeIdToken() { throw new Error('native_demo_identity_not_available'); },
  };
  return {
    provider,
    async consent(request) {
      const url = new URL(request.url);
      if (url.pathname !== '/api/v1/auth/demo/consent') return undefined;
      if (request.method !== 'GET') return new Response(null, { status: 405 });
      cleanup();
      const state = url.searchParams.get('state') ?? '';
      const attempt = attempts.get(state);
      if (!attempt) return new Response('Contoh masuk kedaluwarsa. Kembali lalu mulai lagi.', { status: 400 });
      const choice = url.searchParams.get('identity');
      if (choice !== null) {
        const profile = DEMO_IDENTITIES.find(entry => entry.identity.subject === choice);
        if (!profile) return new Response('Akun contoh tidak tersedia.', { status: 400 });
        const code = token();
        codes.set(code, { ...attempt, state, identity: profile.identity });
        attempts.delete(state);
        const callback = new URL('/api/v1/auth/google/callback', appOrigin);
        callback.searchParams.set('state', state); callback.searchParams.set('code', code);
        return new Response(null, { status: 303, headers: { Location: callback.href } });
      }
      const links = DEMO_IDENTITIES.map(({ identity }) => {
        const href = new URL(url.href); href.searchParams.set('identity', identity.subject);
        return `<li><a href="${escapeHtml(href.pathname + href.search)}">${escapeHtml(identity.displayName)}</a></li>`;
      }).join('');
      return new Response(`<!doctype html><html lang="id"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Simulasi akun Waspada</title><style>body{font:1rem/1.6 system-ui;max-width:42rem;margin:2rem auto;padding:1rem;color:#18323a;background:#f4f8f6}li{margin:1rem 0}a{display:inline-block;min-height:44px;color:#087b75}strong{color:#704300}</style><main><p><strong>DEMO LOKAL — akun rekaan, bukan Google</strong></p><h1>Pilih akun contoh</h1><p>Profil dan role berikut disiapkan di server untuk pengujian. Pada login Google sungguhan, akun baru selalu menjadi Pengguna. Tidak ada koneksi ke Google atau publikasi laporan.</p><ul>${links}</ul><a href="/#masuk">Batalkan dan kembali</a></main></html>`, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" },
      });
    },
  };
}

function escapeHtml(value: string) { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!)); }
