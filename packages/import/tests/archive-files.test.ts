import { describe, expect, it } from 'vitest';

import { referencedFileKeys, rewriteFiles } from '../src/images';
import { DEFAULT_IMPORT_LIMITS } from '../src/limits';
import { importFromMarkdownZip } from '../src/markdown/index';
import { importFromNotionZip } from '../src/notion/index';
import { buildZip } from './helpers/zip';

const text = (value: string) => new TextEncoder().encode(value);

/**
 * Files other than images that the documents of an archive link to: carried as
 * the linking page's files, read only when linked, and never past what is left
 * of the import's expanded-size budget.
 */
describe('files an archive links to', () => {
  it('turns a link to a file in the archive into a file placeholder, and reads only that file', () => {
    const zip = buildZip([
      { name: 'docs/guide.md', content: text('# Guide\n\nThe [spec](files/spec%20v2.pdf) and [nothing](files/missing.pdf).\n') },
      { name: 'docs/files/spec v2.pdf', content: text('%PDF spec') },
      { name: 'docs/files/unlinked.mp4', content: new Uint8Array(1024) },
    ]);
    const result = importFromMarkdownZip({ zip, limits: DEFAULT_IMPORT_LIMITS });
    const page = result.nodes.find((node) => node.title === 'Guide')!;

    expect(referencedFileKeys(page.markdown)).toEqual(['docs/files/spec v2.pdf']);
    expect(result.fileAssets?.map((asset) => [asset.key, new TextDecoder().decode(asset.data)])).toEqual([
      ['docs/files/spec v2.pdf', '%PDF spec'],
    ]);
    expect(result.params['attachment_count']).toBe(1);
    expect(page.warnings).toContainEqual({ code: 'unresolved-link', detail: 'files/missing.pdf' });
    expect(rewriteFiles(page.markdown, (key) => `/files/${encodeURIComponent(key)}`)).toContain(
      '[spec](/files/docs%2Ffiles%2Fspec%20v2.pdf)',
    );
  });

  it('leaves a linked file behind, with a warning, once it would pass the budget', () => {
    const zip = buildZip([
      { name: 'a.md', content: text('[big](big.bin) [small](small.txt)\n') },
      { name: 'big.bin', content: new Uint8Array(4096) },
      { name: 'small.txt', content: text('small') },
    ]);
    const result = importFromMarkdownZip({ zip, limits: { ...DEFAULT_IMPORT_LIMITS, expandedBytes: 1024 } });
    expect(result.fileAssets?.map((asset) => asset.key)).toEqual(['small.txt']);
    expect(result.warnings).toContainEqual({
      code: 'file-skipped',
      detail: 'big.bin: the files of this archive are larger together than an import may expand',
    });
  });

  it('does the same for a Notion export', () => {
    const zip = buildZip([
      { name: 'Export/Plan 0123456789abcdef0123456789abcdef.md', content: text('# Plan\n\nSee [budget](Plan%200123456789abcdef0123456789abcdef/budget.xlsx).\n') },
      { name: 'Export/Plan 0123456789abcdef0123456789abcdef/budget.xlsx', content: text('xlsx bytes') },
    ]);
    const result = importFromNotionZip({ zip, limits: DEFAULT_IMPORT_LIMITS });
    expect(result.fileAssets?.map((asset) => asset.key)).toEqual([
      'Export/Plan 0123456789abcdef0123456789abcdef/budget.xlsx',
    ]);
    expect(referencedFileKeys(result.nodes[0]!.markdown)).toHaveLength(1);
  });
});
