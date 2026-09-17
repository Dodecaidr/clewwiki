import { describe, expect, it } from 'vitest';

import { computeContentHash } from '@/lib/pages/content';
import { exportPageHtml } from '@/lib/pages/export';
import { containsMermaid, escapeHtml, renderMarkdown } from '@/lib/pages/markdown';
import type { PageRecord } from '@/lib/pages/service';

describe('renderMarkdown', () => {
  it('renders headings, lists and links', async () => {
    const html = await renderMarkdown('# Title\n\n- one\n- two\n\n[site](https://example.com)');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<a href="https://example.com">site</a>');
  });

  it('renders GitHub-flavoured tables', async () => {
    const html = await renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
  });

  it('keeps the language class on a fenced code block', async () => {
    const html = await renderMarkdown('```ts\nconst x = 1;\n```');
    expect(html).toContain('class="language-ts"');
  });

  it('turns a mermaid fence into <pre class="mermaid"> holding its source', async () => {
    const html = await renderMarkdown('```mermaid\ngraph TD;\n  A-->B;\n```');
    expect(html).toContain('<pre class="mermaid">graph TD;\n  A-->B;</pre>');
    expect(html).not.toContain('language-mermaid');
  });

  it('does not execute or emit script tags written into a body', async () => {
    const html = await renderMarkdown('<script>alert(1)</script>\n\ntext');
    expect(html).not.toContain('<script');
    expect(html).toContain('text');
  });

  it('strips an event handler attribute smuggled through raw HTML', async () => {
    const html = await renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain('onerror');
  });

  it('drops a javascript: link target', async () => {
    const html = await renderMarkdown('[click](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
  });

  it('renders an empty body without failing', async () => {
    await expect(renderMarkdown('')).resolves.toBe('');
  });
});

describe('containsMermaid', () => {
  it('detects a mermaid fence', () => {
    expect(containsMermaid('text\n\n```mermaid\ngraph TD;\n```')).toBe(true);
    expect(containsMermaid('```ts\nconst x = 1;\n```')).toBe(false);
  });
});

describe('escapeHtml', () => {
  it('escapes the characters that would otherwise become markup', () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;',
    );
  });
});

describe('exportPageHtml', () => {
  const body = '# Auth\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n';

  const page: PageRecord = {
    id: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-0000000000ff',
    parentId: null,
    path: '/backend/auth',
    title: 'Auth & <tokens>',
    kind: 'technical',
    linkedPageId: null,
    body,
    summary: null,
    contentHash: computeContentHash(body),
    version: 2,
    createdByType: 'user',
    createdById: 'user-1',
    updatedByType: 'user',
    updatedById: 'user-1',
    createdAt: new Date('2026-02-03T04:05:06.000Z'),
    updatedAt: new Date('2026-02-03T04:05:06.000Z'),
    deletedAt: null,
  };

  it('produces a standalone document', async () => {
    const exported = await exportPageHtml(page);
    expect(exported.filename).toBe('auth.html');
    expect(exported.contentType).toBe('text/html; charset=utf-8');
    expect(exported.body.startsWith('<!doctype html>')).toBe(true);
    expect(exported.body).toContain('</html>');
  });

  it('escapes the title rather than letting it become markup', async () => {
    const exported = await exportPageHtml(page);
    expect(exported.body).toContain('<title>Auth &amp; &lt;tokens&gt;</title>');
  });

  it('preserves mermaid blocks for a client renderer', async () => {
    const exported = await exportPageHtml(page);
    expect(exported.body).toContain('<pre class="mermaid">');
  });

  it('carries its own print stylesheet, so printing it is the PDF path', async () => {
    const exported = await exportPageHtml(page);
    expect(exported.body).toMatch(/<style>[\s\S]*@media print \{[\s\S]*<\/style>/);
    expect(exported.body).toContain('@page');
    expect(exported.body).not.toMatch(/<link\b/i);
  });

  it('references nothing outside the file', async () => {
    const exported = await exportPageHtml(page);
    expect(exported.body).not.toMatch(/<script/i);
    expect(exported.body).not.toMatch(/https?:\/\//);
  });
});
