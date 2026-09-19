import { describe, expect, it } from 'vitest';

import { importFromNotionZip, stripNotionId, parseCsv } from '../src/notion/index';
import { DEFAULT_IMPORT_LIMITS } from '../src/limits';
import { rewriteLinks } from '../src/links';
import { placeNodes } from '../src/tree';
import { buildZip } from './helpers/zip';

/**
 * A fixture shaped like a real "Export as Markdown & CSV" with subpages: one
 * export folder, hash suffixes everywhere, a nested page, a database as a CSV
 * beside its folder of rows, a callout, a toggle, and a link from one page to
 * another.
 */
const EXPORT = 'Export-08e5c2f1-4f2b-4e2c-9f1a-2b3c4d5e6f70';
const HANDBOOK = 'Engineering handbook 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d';
const DEPLOY = 'Deploying 2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e';
const SERVICES = 'Services 3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f';

function notionZip(): Uint8Array {
  return buildZip([
    {
      name: `${EXPORT}/${HANDBOOK}.md`,
      deflate: true,
      content: [
        '# Engineering handbook',
        '',
        'How this team works.',
        '',
        '> 💡 Read the deployment page before your first release.',
        '',
        '<details>',
        '<summary>Why we do it this way</summary>',
        '',
        'Because the previous way woke people up at night.',
        '',
        '</details>',
        '',
        'See [Deploying](Engineering%20handbook%201a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d/Deploying%202b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e.md).',
        '',
        '![Diagram](Engineering%20handbook%201a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d/flow.png)',
      ].join('\n'),
    },
    {
      name: `${EXPORT}/${HANDBOOK}/${DEPLOY}.md`,
      deflate: true,
      content: ['# Deploying', '', '> ⚠️ Never deploy on a Friday.', '', '1. Tag.', '2. Push.'].join('\n'),
    },
    {
      name: `${EXPORT}/${HANDBOOK}/${SERVICES}.csv`,
      content: 'Name,Owner,Tier\nGateway,Platform,1\nWorker,Platform,2\n',
    },
    {
      name: `${EXPORT}/${HANDBOOK}/${SERVICES}/Gateway 4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90.md`,
      content: '# Gateway\n\nTerminates TLS.',
    },
  ]);
}

describe('notion names', () => {
  it('strips the export hash from a name', () => {
    expect(stripNotionId('Deploying 2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e')).toBe('Deploying');
    expect(stripNotionId('Plain name')).toBe('Plain name');
  });
});

describe('notion CSV', () => {
  it('reads quoted fields, doubled quotes and embedded newlines', () => {
    const table = parseCsv('a,b\n"one, two","he said ""hi""\nagain"\n');
    expect(table.header).toEqual(['a', 'b']);
    expect(table.rows).toEqual([['one, two', 'he said "hi"\nagain']]);
  });
});

describe('notion export import', () => {
  const result = importFromNotionZip({ zip: notionZip(), limits: DEFAULT_IMPORT_LIMITS });
  const placed = placeNodes(result.nodes);
  const byTitle = new Map(placed.nodes.map((node) => [node.title, node]));

  it('builds the tree from the folder structure, hashes stripped', () => {
    expect(placed.nodes.map((node) => node.title).sort()).toEqual([
      'Deploying',
      'Engineering handbook',
      'Gateway',
      'Services',
    ]);
    expect(byTitle.get('Engineering handbook')?.targetPath).toBe('/engineering-handbook');
    expect(byTitle.get('Deploying')?.targetPath).toBe('/engineering-handbook/deploying');
    expect(byTitle.get('Services')?.targetPath).toBe('/engineering-handbook/services');
    expect(byTitle.get('Gateway')?.targetPath).toBe('/engineering-handbook/services/gateway');
  });

  it('turns an emoji callout into the alert its emoji means', () => {
    expect(byTitle.get('Engineering handbook')?.markdown).toContain(
      '> [!TIP]\n> Read the deployment page before your first release.',
    );
    expect(byTitle.get('Deploying')?.markdown).toContain('> [!WARNING]\n> Never deploy on a Friday.');
  });

  it('turns a toggle into a visible summary and warns that the fold is gone', () => {
    const handbook = byTitle.get('Engineering handbook');
    expect(handbook?.markdown).toContain('**Why we do it this way**');
    expect(handbook?.markdown).toContain('Because the previous way woke people up at night.');
    expect(handbook?.markdown).not.toContain('<details>');
    expect(handbook?.warnings).toContainEqual({
      code: 'toggle-converted',
      detail: 'Why we do it this way',
    });
  });

  it('inlines a small database as a GFM table', () => {
    expect(byTitle.get('Services')?.markdown).toContain(
      '| Name | Owner | Tier |\n| --- | --- | --- |\n| Gateway | Platform | 1 |',
    );
  });

  it('links a large database instead of inlining it', () => {
    const rows = Array.from({ length: 200 }, (_, index) => `Row ${index},Owner,3`).join('\n');
    const big = importFromNotionZip({
      zip: buildZip([
        { name: 'Export/Big 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.csv', content: `Name,Owner,Tier\n${rows}\n` },
      ]),
      limits: DEFAULT_IMPORT_LIMITS,
    });
    expect(big.nodes[0]?.markdown).toContain('200 rows');
    expect(big.nodes[0]?.warnings).toContainEqual({ code: 'database-too-large', detail: '200 rows' });
  });

  it('rewrites a link between two exported pages', () => {
    const handbook = byTitle.get('Engineering handbook');
    const rewritten = rewriteLinks(
      handbook?.markdown ?? '',
      (sourceId) => placed.nodes.find((node) => node.sourceId === sourceId)?.targetPath ?? null,
    );
    expect(rewritten.markdown).toContain('[Deploying](/engineering-handbook/deploying)');
  });

  it('warns about an image that will not follow the page', () => {
    expect(byTitle.get('Engineering handbook')?.warnings).toContainEqual({
      code: 'unresolved-image',
      detail: 'Engineering handbook 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d/flow.png',
    });
  });

  it('records a parameter summary with no file contents in it', () => {
    expect(result.params).toEqual({ file_count: 4, page_count: 3, database_count: 1, image_count: 0 });
  });

  it('refuses an archive with no Notion files in it', () => {
    expect(() =>
      importFromNotionZip({
        zip: buildZip([{ name: 'export/logo.png', content: 'binary' }]),
        limits: DEFAULT_IMPORT_LIMITS,
      }),
    ).toThrow(/no Notion/);
  });
});
