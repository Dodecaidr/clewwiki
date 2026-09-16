import { describe, expect, it } from 'vitest';

import {
  InvalidPathError,
  isDescendantPath,
  joinPath,
  lastSegment,
  likePrefixPattern,
  normalizePath,
  parentPathOf,
  pathDepth,
  rewritePathPrefix,
  slugifySegment,
} from '@/lib/pages/paths';

describe('slugifySegment', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifySegment('Auth Service')).toBe('auth-service');
  });

  it('collapses runs of separators and trims them', () => {
    expect(slugifySegment('  --Auth___Service!!  ')).toBe('auth-service');
  });

  it('strips diacritics rather than dropping the letter', () => {
    expect(slugifySegment('Café Ordering')).toBe('cafe-ordering');
  });

  it('returns an empty string when nothing survives', () => {
    expect(slugifySegment('———')).toBe('');
    expect(slugifySegment('')).toBe('');
  });
});

describe('normalizePath', () => {
  it('produces a leading slash and no trailing slash', () => {
    expect(normalizePath('backend/auth/')).toBe('/backend/auth');
    expect(normalizePath('/backend/auth')).toBe('/backend/auth');
  });

  it('drops empty segments', () => {
    expect(normalizePath('//backend///auth//')).toBe('/backend/auth');
  });

  it('normalises each segment', () => {
    expect(normalizePath('/Backend Services/Auth Flow')).toBe('/backend-services/auth-flow');
  });

  it('rejects a path with no usable segment', () => {
    expect(() => normalizePath('/')).toThrow(InvalidPathError);
    expect(() => normalizePath('   ')).toThrow(InvalidPathError);
    expect(() => normalizePath('/!!!/')).toThrow(InvalidPathError);
  });

  it('rejects a path deeper than the limit', () => {
    expect(() => normalizePath('/' + Array.from({ length: 13 }, (_, i) => `s${i}`).join('/'))).toThrow(
      InvalidPathError,
    );
  });
});

describe('joinPath', () => {
  it('appends to a parent', () => {
    expect(joinPath('/backend', 'Auth Flow')).toBe('/backend/auth-flow');
  });

  it('treats a null parent as the root', () => {
    expect(joinPath(null, 'Backend')).toBe('/backend');
  });

  it('rejects a segment that slugifies to nothing', () => {
    expect(() => joinPath('/backend', '???')).toThrow(InvalidPathError);
  });
});

describe('parentPathOf and lastSegment', () => {
  it('walks one level up', () => {
    expect(parentPathOf('/backend/auth/tokens')).toBe('/backend/auth');
    expect(parentPathOf('/backend')).toBeNull();
  });

  it('reads the final segment', () => {
    expect(lastSegment('/backend/auth')).toBe('auth');
    expect(lastSegment('/backend')).toBe('backend');
  });

  it('counts depth', () => {
    expect(pathDepth('/backend/auth')).toBe(2);
    expect(pathDepth('/backend')).toBe(1);
  });
});

describe('isDescendantPath', () => {
  it('recognises a descendant at any depth', () => {
    expect(isDescendantPath('/backend/auth', '/backend')).toBe(true);
    expect(isDescendantPath('/backend/auth/tokens', '/backend')).toBe(true);
  });

  it('does not treat a page as its own descendant', () => {
    expect(isDescendantPath('/backend', '/backend')).toBe(false);
  });

  it('does not match a sibling with a shared prefix', () => {
    // The trap a naive `startsWith` falls into: `/backend-api` is not below
    // `/backend`, and a move that assumed it was would corrupt the tree.
    expect(isDescendantPath('/backend-api', '/backend')).toBe(false);
  });
});

describe('rewritePathPrefix', () => {
  it('moves a whole subtree', () => {
    expect(rewritePathPrefix('/backend/auth/tokens', '/backend', '/platform')).toBe(
      '/platform/auth/tokens',
    );
  });

  it('moves the ancestor itself', () => {
    expect(rewritePathPrefix('/backend', '/backend', '/platform')).toBe('/platform');
  });

  it('refuses a path outside the subtree', () => {
    expect(() => rewritePathPrefix('/frontend/auth', '/backend', '/platform')).toThrow(
      InvalidPathError,
    );
  });
});

describe('likePrefixPattern', () => {
  it('matches the subtree and not the page itself', () => {
    expect(likePrefixPattern('/backend')).toBe('/backend/%');
  });

  it('escapes LIKE wildcards so a sibling cannot be swept in', () => {
    expect(likePrefixPattern('/a_b')).toBe('/a\\_b/%');
    expect(likePrefixPattern('/a%b')).toBe('/a\\%b/%');
  });
});
