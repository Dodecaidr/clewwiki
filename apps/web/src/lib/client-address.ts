import { isIP } from 'node:net';

import { getTrustedClientIpHeader } from './env';

/**
 * The key every per-client limit falls back to when the client's address
 * cannot be established. All such requests share one bucket: a deployment
 * whose proxy does not set the trusted header is throttled as a whole rather
 * than trusting an address the client wrote itself.
 */
export const SHARED_CLIENT_KEY = 'unknown-client';

interface HeaderSource {
  get(name: string): string | null;
}

/**
 * The client address from the one header the operator's proxy is trusted to
 * set (`TRUSTED_CLIENT_IP_HEADER`, `x-real-ip` by default), or null.
 *
 * Only a single, syntactically valid IP address is accepted. A list — which is
 * what `X-Forwarded-For` looks like after a proxy appended to it — is refused,
 * because its leftmost entry is whatever the client sent.
 */
export function resolveClientAddress(
  headers: HeaderSource,
  headerName: string = getTrustedClientIpHeader(),
): string | null {
  const raw = headers.get(headerName);
  if (raw === null) return null;
  const value = raw.trim();
  if (value === '' || value.includes(',') || value.length > 64) return null;
  return isIP(value) === 0 ? null : value;
}

/** The rate-limit key for a client: its address, or the shared bucket. */
export function clientKey(headers: HeaderSource, headerName?: string): string {
  return resolveClientAddress(headers, headerName) ?? SHARED_CLIENT_KEY;
}
