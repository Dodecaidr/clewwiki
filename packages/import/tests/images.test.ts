import { describe, expect, it } from 'vitest';

import {
  archivePathHref,
  imagePlaceholderFor,
  referencedImageKeys,
  rewriteImages,
} from '../src/images';
import { DEFAULT_IMPORT_LIMITS } from '../src/limits';
import { placeholderFor, rewriteLinks } from '../src/links';
import { importFromMarkdownZip } from '../src/markdown/index';
import { importFromNotionZip } from '../src/notion/index';
import { buildZip } from './helpers/zip';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);

describe('image placeholders', () => {
  it('survives a name with spaces and parentheses', () => {
    const key = 'Page a1/Untitled (1).png';
    const markdown = `![shot](${imagePlaceholderFor(key)} "A title")`;
    expect(markdown).not.toMatch(/\(1\)/);
    expect(referencedImageKeys(markdown)).toEqual([key]);
    expect(rewriteImages(markdown, () => '/api/v1/images/x')).toBe('![shot](/api/v1/images/x "A title")');
  });

  it('lists a key once however often it is shown', () => {
    const markdown = `![a](${imagePlaceholderFor('a.png')}) ![b](${imagePlaceholderFor('a.png')})`;
    expect(referencedImageKeys(markdown)).toEqual(['a.png']);
  });

  it('is left alone by the link rewriter', () => {
    const markdown = `![a](${imagePlaceholderFor('a.png')}) [b](${placeholderFor('b')})`;
    expect(rewriteLinks(markdown, () => '/b').markdown).toBe(`![a](${imagePlaceholderFor('a.png')}) [b](/b)`);
  });

  it('falls back to a path that is still one Markdown destination', () => {
    expect(archivePathHref('img/Untitled (1).png')).toBe('img/Untitled%20%281%29.png');
  });
});

describe('link placeholders', () => {
  it('resolves a source id with parentheses in it', () => {
    const markdown = `[copy](${placeholderFor('notes/Plan (1)')})`;
    expect(rewriteLinks(markdown, (id) => (id === 'notes/Plan (1)' ? '/plan-1' : null)).markdown).toBe(
      '[copy](/plan-1)',
    );
  });
});

describe('markdown folder images', () => {
  const result = importFromMarkdownZip({
    zip: buildZip([
      {
        name: 'repo/docs/README.md',
        content: [
          '# Docs',
          '',
          '![Arch](./img/arch.png)',
          '![Again](img/arch.png "Same file")',
          '![Shared](../assets/Shot%20(1).jpg)',
          '![Vector](img/logo.svg)',
          '![Gone](img/missing.png)',
          '![Remote](https://example.com/a.png)',
        ].join('\n'),
      },
      { name: 'repo/docs/guide/setup.md', content: '# Setup\n\n![Arch](../img/arch.png)' },
      { name: 'repo/docs/img/arch.png', content: PNG },
      { name: 'repo/docs/img/unused.png', content: PNG },
      { name: 'repo/docs/img/logo.svg', content: '<svg></svg>' },
      { name: 'repo/assets/Shot (1).jpg', content: JPEG },
    ]),
    limits: DEFAULT_IMPORT_LIMITS,
  });
  const docs = result.nodes.find((node) => node.title === 'Docs');
  const setup = result.nodes.find((node) => node.title === 'Setup');

  it('carries the images the documents show, and only those', () => {
    expect(result.assets?.map((asset) => asset.key)).toEqual([
      'repo/docs/img/arch.png',
      'repo/assets/Shot (1).jpg',
    ]);
    expect(result.assets?.[0]?.data).toEqual(PNG);
    expect(result.params['image_count']).toBe(2);
  });

  it('writes each of them as a placeholder, title kept', () => {
    expect(referencedImageKeys(docs?.markdown ?? '')).toEqual([
      'repo/docs/img/arch.png',
      'repo/assets/Shot (1).jpg',
    ]);
    expect(docs?.markdown).toContain(`![Again](${imagePlaceholderFor('repo/docs/img/arch.png')} "Same file")`);
  });

  it('finds an image above the folder the documents share', () => {
    expect(docs?.markdown).toContain(`![Shared](${imagePlaceholderFor('repo/assets/Shot (1).jpg')})`);
  });

  it('resolves the same image from a nested document', () => {
    expect(referencedImageKeys(setup?.markdown ?? '')).toEqual(['repo/docs/img/arch.png']);
  });

  it('warns about what it could not take, and leaves it as written', () => {
    expect(docs?.warnings).toEqual([
      { code: 'unresolved-image', detail: 'img/logo.svg' },
      { code: 'unresolved-image', detail: 'img/missing.png' },
    ]);
    expect(docs?.markdown).toContain('![Vector](img/logo.svg)');
    expect(docs?.markdown).toContain('![Remote](https://example.com/a.png)');
  });

  it('counts only the files it made no use of', () => {
    expect(result.warnings).toEqual([
      { code: 'unresolved-image', detail: '2 files that are neither Markdown nor an image a page shows' },
    ]);
  });
});

describe('what an archive is read for', () => {
  it('does not expand, or count, a file that is neither a document nor a picture', () => {
    const limits = { ...DEFAULT_IMPORT_LIMITS, expandedBytes: 1024 };
    const zip = buildZip([
      { name: 'docs/a.md', content: '# A\n\n![p](p.png)' },
      { name: 'docs/p.png', content: PNG },
      { name: 'docs/demo.mp4', content: new Uint8Array(4096) },
    ]);
    const result = importFromMarkdownZip({ zip, limits });
    expect(result.assets).toHaveLength(1);
    expect(result.warnings).toEqual([
      { code: 'unresolved-image', detail: '1 files that are neither Markdown nor an image a page shows' },
    ]);
    expect(importFromNotionZip({ zip, limits }).assets).toHaveLength(1);
  });
});

describe('notion export images', () => {
  const EXPORT = 'Export-08e5c2f1-4f2b-4e2c-9f1a-2b3c4d5e6f70';
  const A = 'Alpha 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d';
  const A2 = 'Alpha 9a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d';
  const result = importFromNotionZip({
    zip: buildZip([
      { name: `${EXPORT}/${A}.md`, content: `# Alpha\n\n![Untitled](${encodeURI(A)}/Untitled.png)` },
      { name: `${EXPORT}/${A2}.md`, content: `# Alpha two\n\n![Untitled](${encodeURI(A2)}/Untitled.png)` },
      { name: `${EXPORT}/${A}/Untitled.png`, content: PNG },
      { name: `${EXPORT}/${A2}/Untitled.png`, content: JPEG },
    ]),
    limits: DEFAULT_IMPORT_LIMITS,
  });

  it('keeps two pictures apart when their folders strip to one name', () => {
    expect(result.assets?.map((asset) => [asset.key, asset.data])).toEqual([
      [`${EXPORT}/${A}/Untitled.png`, PNG],
      [`${EXPORT}/${A2}/Untitled.png`, JPEG],
    ]);
    const second = result.nodes.find((node) => node.title === 'Alpha two');
    expect(referencedImageKeys(second?.markdown ?? '')).toEqual([`${EXPORT}/${A2}/Untitled.png`]);
    expect(second?.warnings).toEqual([]);
  });
});
