import { describe, expect, it } from 'vitest';

import { DEFAULT_IMPORT_LIMITS, ImportError } from '../src/limits';
import { importFromMarkdownZip } from '../src/markdown/index';
import { rewriteLinks } from '../src/links';
import { placeNodes } from '../src/tree';
import { splitFrontMatter } from '../src/doctree';
import { readZip } from '../src/zip';
import { buildZip } from './helpers/zip';

function docsZip(): Uint8Array {
  return buildZip([
    {
      name: 'docs/README.md',
      deflate: true,
      content: [
        '---',
        'title: Platform documentation',
        'sidebar_position: 1',
        '---',
        '',
        'Everything about the platform.',
        '',
        'Start with [deployment](backend/deploy.md) or the [glossary](./glossary.md).',
        '',
        '![Architecture](./img/arch.svg)',
      ].join('\n'),
    },
    { name: 'docs/glossary.md', content: '# Glossary\n\n**Claim** — a lease on a page.' },
    { name: 'docs/backend/index.md', content: '# Backend\n\nThe services behind the gateway.' },
    {
      name: 'docs/backend/deploy.md',
      content: '# Deploying the backend\n\nBack to the [index](./index.md).',
    },
    { name: 'docs/img/arch.svg', content: '<svg></svg>' },
    { name: 'docs/__MACOSX/._README.md', content: 'junk' },
  ]);
}

describe('front matter', () => {
  it('reads a title and removes the block', () => {
    const result = splitFrontMatter('---\ntitle: "A page"\nother: 1\n---\nBody.\n');
    expect(result.title).toBe('A page');
    expect(result.body).toBe('Body.\n');
  });

  it('leaves a document with no front matter alone', () => {
    expect(splitFrontMatter('# Heading\n')).toEqual({ title: null, body: '# Heading\n' });
  });
});

describe('markdown folder import', () => {
  const result = importFromMarkdownZip({ zip: docsZip(), limits: DEFAULT_IMPORT_LIMITS });
  const placed = placeNodes(result.nodes);
  const byTitle = new Map(placed.nodes.map((node) => [node.title, node]));

  it('makes the directory structure the tree, with README as the section page', () => {
    expect(byTitle.get('Platform documentation')?.targetPath).toBe('/platform-documentation');
    expect(byTitle.get('Backend')?.targetPath).toBe('/backend');
    expect(byTitle.get('Deploying the backend')?.targetPath).toBe('/backend/deploying-the-backend');
    expect(byTitle.get('Deploying the backend')?.parentSourceId).toBe('backend');
  });

  it('prefers front matter over the file name and the first heading', () => {
    expect([...byTitle.keys()].sort()).toEqual([
      'Backend',
      'Deploying the backend',
      'Glossary',
      'Platform documentation',
    ]);
  });

  it('rewrites a relative link to another imported document', () => {
    const readme = byTitle.get('Platform documentation');
    const rewritten = rewriteLinks(
      readme?.markdown ?? '',
      (sourceId) => placed.nodes.find((node) => node.sourceId === sourceId)?.targetPath ?? null,
    );
    expect(rewritten.markdown).toContain('[deployment](/backend/deploying-the-backend)');
    expect(rewritten.markdown).toContain('[glossary](/glossary)');
  });

  it('rewrites a link that climbs back to a directory index', () => {
    const deploy = byTitle.get('Deploying the backend');
    const rewritten = rewriteLinks(
      deploy?.markdown ?? '',
      (sourceId) => placed.nodes.find((node) => node.sourceId === sourceId)?.targetPath ?? null,
    );
    expect(rewritten.markdown).toContain('[index](/backend)');
  });

  it('warns about a relative image, which has nowhere to go', () => {
    expect(byTitle.get('Platform documentation')?.warnings).toContainEqual({
      code: 'unresolved-image',
      detail: 'img/arch.svg',
    });
  });

  it('ignores archive junk', () => {
    expect([...byTitle.keys()]).not.toContain('README');
  });

  it('strips the wrapping folder, so no page is named after it', () => {
    expect(result.params['root']).toBe('docs');
  });

  it('refuses an archive with no Markdown in it', () => {
    expect(() =>
      importFromMarkdownZip({
        zip: buildZip([{ name: 'a/b.txt', content: 'x' }]),
        limits: DEFAULT_IMPORT_LIMITS,
      }),
    ).toThrow(/no Markdown/);
  });

  it('refuses an archive with more files than the page limit allows', () => {
    const many = Array.from({ length: 6 }, (_, index) => ({
      name: `docs/page-${index}.md`,
      content: '# x',
    }));
    expect(() =>
      importFromMarkdownZip({ zip: buildZip(many), limits: { ...DEFAULT_IMPORT_LIMITS, pages: 3 } }),
    ).toThrow(/more than 3/);
  });
});

describe('zip reader', () => {
  it('reads both stored and deflated entries', () => {
    const zip = buildZip([
      { name: 'stored.md', content: '# stored' },
      { name: 'deflated.md', content: '# deflated'.repeat(50), deflate: true },
    ]);
    const files = readZip(zip, { limits: DEFAULT_IMPORT_LIMITS });
    expect(files.map((file) => file.name)).toEqual(['stored.md', 'deflated.md']);
    expect(new TextDecoder().decode(files[1]?.data)).toBe('# deflated'.repeat(50));
  });

  it('refuses something that is not an archive', () => {
    expect(() => readZip(new Uint8Array(40), { limits: DEFAULT_IMPORT_LIMITS })).toThrow(ImportError);
  });

  it('skips an entry whose name would escape the archive root', () => {
    const zip = buildZip([
      { name: '../escape.md', content: '# no' },
      { name: 'ok.md', content: '# yes' },
    ]);
    expect(readZip(zip, { limits: DEFAULT_IMPORT_LIMITS }).map((file) => file.name)).toEqual(['ok.md']);
  });

  it('refuses an archive that expands past the limit', () => {
    const zip = buildZip([{ name: 'big.md', content: 'x'.repeat(5_000), deflate: true }]);
    expect(() =>
      readZip(zip, { limits: { expandedBytes: 1_000, zipEntries: 100 } }),
    ).toThrow(/size limit/);
  });

  it('refuses an archive with more entries than the limit allows', () => {
    const zip = buildZip(
      Array.from({ length: 5 }, (_, index) => ({ name: `f${index}.md`, content: 'x' })),
    );
    expect(() => readZip(zip, { limits: { expandedBytes: 1e9, zipEntries: 3 } })).toThrow(/more than 3/);
  });
});
