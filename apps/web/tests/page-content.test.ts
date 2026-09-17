import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { computeContentHash, isContentHash, matchesContentHash } from '@/lib/pages/content';
import { exportPageMarkdown } from '@/lib/pages/export';
import type { PageRecord } from '@/lib/pages/service';

function page(overrides: Partial<PageRecord> = {}): PageRecord {
  const now = new Date('2026-02-03T04:05:06.000Z');
  return {
    id: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-0000000000ff',
    spaceId: '00000000-0000-4000-8000-0000000000aa',
    parentId: null,
    path: '/backend/auth',
    title: 'Auth',
    kind: 'technical',
    linkedPageId: null,
    body: '# Auth\n',
    summary: null,
    contentHash: computeContentHash('# Auth\n'),
    version: 3,
    createdByType: 'user',
    createdById: 'user-1',
    updatedByType: 'agent',
    updatedById: 'token-1',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

describe('computeContentHash', () => {
  it('is SHA-256 of the body, hex encoded', () => {
    expect(computeContentHash('hello')).toBe(
      createHash('sha256').update('hello', 'utf8').digest('hex'),
    );
  });

  it('is stable for the same input', () => {
    expect(computeContentHash('# Title\n\nbody')).toBe(computeContentHash('# Title\n\nbody'));
  });

  it('changes for trailing whitespace, which is part of the content', () => {
    expect(computeContentHash('body')).not.toBe(computeContentHash('body '));
    expect(computeContentHash('body')).not.toBe(computeContentHash('body\n'));
  });

  it('changes for a one-character edit', () => {
    expect(computeContentHash('The cat sat')).not.toBe(computeContentHash('The bat sat'));
  });

  it('handles an empty body and non-ASCII content', () => {
    expect(computeContentHash('')).toMatch(/^[0-9a-f]{64}$/);
    expect(computeContentHash('диаграмма 図')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('matchesContentHash', () => {
  it('accepts the matching body and rejects a changed one', () => {
    const body = '# Auth\n\nTokens.';
    const hash = computeContentHash(body);
    expect(matchesContentHash(body, hash)).toBe(true);
    expect(matchesContentHash(body + ' ', hash)).toBe(false);
  });
});

describe('isContentHash', () => {
  it('accepts a hex digest and rejects anything else', () => {
    expect(isContentHash(computeContentHash('x'))).toBe(true);
    expect(isContentHash('not-a-hash')).toBe(false);
    expect(isContentHash(computeContentHash('x').toUpperCase())).toBe(false);
  });
});

describe('exportPageMarkdown', () => {
  it('writes front matter followed by the body, unmodified', () => {
    const exported = exportPageMarkdown(page({ body: '# Auth\n\nTokens live here.\n' }));

    expect(exported.contentType).toBe('text/markdown; charset=utf-8');
    expect(exported.filename).toBe('auth.md');
    expect(exported.body).toBe(
      [
        '---',
        'title: "Auth"',
        'path: "/backend/auth"',
        'kind: technical',
        'version: 3',
        `content_hash: "${computeContentHash('# Auth\n')}"`,
        'updated_at: "2026-02-03T04:05:06.000Z"',
        '---',
        '',
        '# Auth',
        '',
        'Tokens live here.',
        '',
      ].join('\n'),
    );
  });

  it('quotes a title containing YAML punctuation', () => {
    const exported = exportPageMarkdown(page({ title: 'Auth: tokens, "scopes" & TTL' }));
    expect(exported.body).toContain('title: "Auth: tokens, \\"scopes\\" & TTL"');
  });

  it('always terminates the body with a newline', () => {
    const exported = exportPageMarkdown(page({ body: 'no trailing newline' }));
    expect(exported.body.endsWith('no trailing newline\n')).toBe(true);
  });
});
