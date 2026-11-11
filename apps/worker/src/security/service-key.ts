/**
 * Shared-secret checks for machine-to-machine routes (internal proposals, webhook ingest).
 * Both sides are hashed before comparison, so the check runs in constant time and does not
 * reveal the configured key's length.
 */
export const SERVICE_KEY_HEADER = 'x-service-key';

export type ServiceKeyDecision = 'unconfigured' | 'unauthorized' | 'authorized';

export async function checkServiceKey(request: Request, configuredKey: string | undefined): Promise<ServiceKeyDecision> {
  if (typeof configuredKey !== 'string' || configuredKey.length === 0) return 'unconfigured';
  const provided = request.headers.get(SERVICE_KEY_HEADER);
  if (provided === null || provided.length === 0) return 'unauthorized';
  const [providedDigest, configuredDigest] = await Promise.all([sha256Bytes(provided), sha256Bytes(configuredKey)]);
  let difference = 0;
  for (let index = 0; index < configuredDigest.length; index += 1) {
    difference |= providedDigest[index]! ^ configuredDigest[index]!;
  }
  return difference === 0 ? 'authorized' : 'unauthorized';
}

/** Random 256-bit secret, generated per process when no configured key is supplied. */
export function generateServiceKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}
