import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { getConfiguredSetupToken } from './env';

/**
 * The one-time token first-run setup requires.
 *
 * A fresh instance has no accounts, and whoever submits `/setup` first becomes
 * its administrator. Binding the port to loopback narrows who that can be; the
 * token decides it. It proves that the person at the form can also read the
 * server's configuration or its log — that they operate the machine.
 *
 * - When `CLEWWIKI_SETUP_TOKEN` is set, that value is the token.
 * - Otherwise one is generated the first time it is needed (at start-up when
 *   the instance has no accounts, or when `/setup` is first rendered), printed
 *   once to the server log, and kept in this process's memory only. A restart
 *   generates a new one.
 *
 * It stops mattering the moment an account exists: `/setup` answers 404 from
 * then on, and the generated value is forgotten.
 */

declare global {
  var __clewwikiSetupToken: string | undefined;
}

/** The log line an operator greps for; the README quotes it. */
export const SETUP_TOKEN_LOG_PREFIX = '[setup] one-time setup token:';

/**
 * Returns the token, generating and printing one if none is configured and
 * none has been generated in this process yet.
 */
export function ensureSetupToken(log: (line: string) => void = console.log): string {
  const configured = getConfiguredSetupToken();
  if (configured !== null) return configured;

  if (!globalThis.__clewwikiSetupToken) {
    globalThis.__clewwikiSetupToken = randomBytes(18).toString('base64url');
    log(
      `${SETUP_TOKEN_LOG_PREFIX} ${globalThis.__clewwikiSetupToken} ` +
        '(no account exists yet; enter it on /setup to create the administrator)',
    );
  }
  return globalThis.__clewwikiSetupToken;
}

/**
 * Constant-time comparison of a submitted token against the expected one.
 * Both sides are hashed first, so the comparison does not leak the length of
 * the expected value either.
 */
export function setupTokenMatches(submitted: string, expected: string): boolean {
  const a = createHash('sha256').update(submitted.trim()).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Checks a submitted token against the one this instance expects. */
export function verifySetupToken(submitted: string | null | undefined): boolean {
  if (typeof submitted !== 'string' || submitted.trim() === '') return false;
  return setupTokenMatches(submitted, ensureSetupToken());
}

/** Forgets a generated token once setup has completed. */
export function clearSetupToken(): void {
  globalThis.__clewwikiSetupToken = undefined;
}
