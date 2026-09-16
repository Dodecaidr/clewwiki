import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  classifyTokenLifecycle,
  extractBearerToken,
  generateAgentToken,
  hashTokenSecret,
  parseAgentToken,
  secureCompareHash,
  verifyTokenSecret,
} from '@/lib/agent-token-crypto';

describe('generateAgentToken', () => {
  it('produces a token whose parts round-trip through the parser', () => {
    const generated = generateAgentToken();
    const parsed = parseAgentToken(generated.token);

    expect(parsed).not.toBeNull();
    expect(parsed?.prefix).toBe(generated.prefix);
    expect(hashTokenSecret(parsed!.secret)).toBe(generated.tokenHash);
  });

  it('never embeds the stored hash in the token itself', () => {
    const generated = generateAgentToken();
    expect(generated.token).not.toContain(generated.tokenHash);
  });

  it('produces a distinct prefix and secret on every call', () => {
    const tokens = Array.from({ length: 50 }, () => generateAgentToken());
    expect(new Set(tokens.map((t) => t.prefix)).size).toBe(50);
    expect(new Set(tokens.map((t) => t.tokenHash)).size).toBe(50);
  });
});

describe('hashTokenSecret', () => {
  it('is a plain SHA-256 of the secret, hex-encoded', () => {
    const secret = 'a-secret-value';
    expect(hashTokenSecret(secret)).toBe(createHash('sha256').update(secret, 'utf8').digest('hex'));
    expect(hashTokenSecret(secret)).toHaveLength(64);
  });
});

describe('parseAgentToken', () => {
  it.each([
    ['empty string', ''],
    ['wrong label', 'abc_prefix1.secretsecretsecret12'],
    ['missing secret', 'cww_prefix1.'],
    ['missing prefix', 'cww_.secretsecretsecret1234567890'],
    ['illegal characters', 'cww_pre$fix.secretsecretsecret12'],
    ['no separators', 'cwwprefixsecret'],
    ['underscore used as separator', 'cww_prefix1_secretsecretsecret12'],
  ])('rejects %s', (_label, value) => {
    expect(parseAgentToken(value)).toBeNull();
  });

  it('splits unambiguously when either half contains an underscore', () => {
    // base64url includes `_`, so a separator drawn from that alphabet would
    // make the split depend on where the random bytes happened to land.
    const parsed = parseAgentToken('cww_a_b_cd.ef_gh_ijklmnopqrstuvwx');
    expect(parsed).toEqual({ prefix: 'a_b_cd', secret: 'ef_gh_ijklmnopqrstuvwx' });
  });

  it('tolerates surrounding whitespace', () => {
    const generated = generateAgentToken();
    expect(parseAgentToken(`  ${generated.token}\n`)?.prefix).toBe(generated.prefix);
  });
});

describe('verifyTokenSecret', () => {
  it('accepts the matching secret', () => {
    const generated = generateAgentToken();
    const parsed = parseAgentToken(generated.token)!;
    expect(verifyTokenSecret(parsed.secret, generated.tokenHash)).toBe(true);
  });

  it('rejects a secret from a different token', () => {
    const a = generateAgentToken();
    const b = generateAgentToken();
    const parsedB = parseAgentToken(b.token)!;
    expect(verifyTokenSecret(parsedB.secret, a.tokenHash)).toBe(false);
  });

  it('rejects an empty or malformed stored hash', () => {
    expect(verifyTokenSecret('anything', '')).toBe(false);
    expect(verifyTokenSecret('anything', 'not-hex')).toBe(false);
  });
});

describe('secureCompareHash', () => {
  it('matches identical digests and rejects differing ones', () => {
    const digest = hashTokenSecret('x');
    expect(secureCompareHash(digest, digest)).toBe(true);
    expect(secureCompareHash(digest, hashTokenSecret('y'))).toBe(false);
  });

  it('rejects digests of different lengths instead of throwing', () => {
    expect(secureCompareHash(hashTokenSecret('x'), 'ab12')).toBe(false);
    expect(secureCompareHash('', '')).toBe(false);
  });
});

describe('extractBearerToken', () => {
  it('reads the token out of a well-formed header', () => {
    expect(extractBearerToken('Bearer cww_abc.def')).toBe('cww_abc.def');
    expect(extractBearerToken('  Bearer   cww_abc.def  ')).toBe('cww_abc.def');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['other scheme', 'Basic dXNlcjpwYXNz'],
    ['lowercase scheme', 'bearer cww_abc.def'],
    ['no value', 'Bearer'],
  ])('returns null for %s', (_label, value) => {
    expect(extractBearerToken(value)).toBeNull();
  });
});

describe('classifyTokenLifecycle', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const past = new Date('2025-12-01T00:00:00Z');
  const future = new Date('2026-02-01T00:00:00Z');

  it('treats a token with no expiry and no revocation as active', () => {
    expect(classifyTokenLifecycle({ revokedAt: null, expiresAt: null }, now)).toBe('active');
  });

  it('treats a future expiry as active', () => {
    expect(classifyTokenLifecycle({ revokedAt: null, expiresAt: future }, now)).toBe('active');
  });

  it('treats a past expiry as expired', () => {
    expect(classifyTokenLifecycle({ revokedAt: null, expiresAt: past }, now)).toBe('expired');
  });

  it('treats an expiry exactly at the current instant as expired', () => {
    expect(classifyTokenLifecycle({ revokedAt: null, expiresAt: now }, now)).toBe('expired');
  });

  it('reports revocation in preference to expiry', () => {
    expect(classifyTokenLifecycle({ revokedAt: past, expiresAt: past }, now)).toBe('revoked');
  });

  it('ignores a revocation timestamp in the future', () => {
    expect(classifyTokenLifecycle({ revokedAt: future, expiresAt: null }, now)).toBe('active');
  });
});
