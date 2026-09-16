import { describe, expect, it } from 'vitest';

import { AGENT_SCOPES, hasAllScopes, hasScope, isAgentScope, normalizeScopes } from '@/lib/scopes';

describe('normalizeScopes', () => {
  it('drops unknown scopes', () => {
    expect(normalizeScopes(['identity:read', 'pages:delete', 'nonsense'])).toEqual([
      'identity:read',
    ]);
  });

  it('de-duplicates and returns scopes in the canonical order', () => {
    expect(normalizeScopes(['pages:read', 'identity:read', 'pages:read'])).toEqual([
      'identity:read',
      'pages:read',
    ]);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeScopes([' pages:write '])).toEqual(['pages:write']);
  });

  it('returns an empty list for an empty input', () => {
    expect(normalizeScopes([])).toEqual([]);
  });

  it('never invents a wildcard from user input', () => {
    expect(normalizeScopes(['*', 'pages:*'])).toEqual([]);
  });
});

describe('isAgentScope', () => {
  it('accepts every declared scope', () => {
    for (const scope of AGENT_SCOPES) {
      expect(isAgentScope(scope)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    expect(isAgentScope('pages:delete')).toBe(false);
    expect(isAgentScope('')).toBe(false);
  });
});

describe('hasScope', () => {
  it('matches an exact grant', () => {
    expect(hasScope(['pages:read'], 'pages:read')).toBe(true);
  });

  it('does not match a different action on the same resource', () => {
    expect(hasScope(['pages:read'], 'pages:write')).toBe(false);
  });

  it('does not match a different resource', () => {
    expect(hasScope(['pages:read'], 'audit:read')).toBe(false);
  });

  it('honours a resource wildcard on the granting side', () => {
    expect(hasScope(['pages:*'], 'pages:write')).toBe(true);
    expect(hasScope(['pages:*'], 'audit:read')).toBe(false);
  });

  it('honours a full wildcard on the granting side', () => {
    expect(hasScope(['*'], 'audit:read')).toBe(true);
  });

  it('refuses a wildcard on the requesting side', () => {
    // A handler asking for `pages:*` must never be satisfied by `pages:read`.
    expect(hasScope(['pages:read'], 'pages:*')).toBe(false);
    expect(hasScope(['*'], '*')).toBe(false);
  });

  it('rejects everything when nothing is granted', () => {
    expect(hasScope([], 'identity:read')).toBe(false);
  });
});

describe('hasAllScopes', () => {
  it('requires every listed scope', () => {
    expect(hasAllScopes(['identity:read', 'pages:read'], ['identity:read', 'pages:read'])).toBe(
      true,
    );
    expect(hasAllScopes(['identity:read'], ['identity:read', 'pages:read'])).toBe(false);
  });

  it('is satisfied vacuously by an empty requirement', () => {
    expect(hasAllScopes([], [])).toBe(true);
  });
});
