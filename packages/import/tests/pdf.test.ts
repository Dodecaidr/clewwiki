import { describe, expect, it } from 'vitest';

import { DEFAULT_IMPORT_LIMITS } from '../src/limits';
import { importFromPdf } from '../src/pdf/index';
import { asTable, groupLines, reconstruct } from '../src/pdf/layout';
import { buildPdf } from './helpers/pdf';

/**
 * The PDF the tests read is generated here, so what every assertion depends on
 * — this heading is 20pt, that body text is 11pt, these columns start at x = 72
 * and x = 300 — is visible in the test rather than hidden in a binary.
 *
 * The suite does run the real reader: the reconstruction is only worth anything
 * if it works on the item stream a PDF engine actually produces.
 */

const RUNBOOK = buildPdf([
  [
    { text: 'Gateway runbook', x: 72, y: 720, size: 20 },
    { text: 'The gateway terminates TLS and forwards requests to the workers.', x: 72, y: 690, size: 11 },
    { text: 'It is restarted nightly, and the restart is logged.', x: 72, y: 676, size: 11 },
    { text: 'Restarting', x: 72, y: 630, size: 14 },
    { text: 'Drain the node, then restart the unit:', x: 72, y: 606, size: 11 },
    { text: 'systemctl restart gateway', x: 72, y: 586, size: 11, font: 'F2' },
    { text: 'Limits', x: 72, y: 540, size: 14 },
    { text: 'Setting', x: 72, y: 516, size: 11 },
    { text: 'Value', x: 300, y: 516, size: 11 },
    { text: 'Timeout', x: 72, y: 500, size: 11 },
    { text: '30s', x: 300, y: 500, size: 11 },
    { text: 'Retries', x: 72, y: 484, size: 11 },
    { text: '3', x: 300, y: 484, size: 11 },
  ],
]);

describe('pdf reconstruction', () => {
  it('rebuilds headings, paragraphs, code and a table from one page', async () => {
    const result = await importFromPdf({
      pdf: RUNBOOK,
      documentTitle: 'gateway_runbook.pdf',
      limits: DEFAULT_IMPORT_LIMITS,
    });

    expect(result.source).toBe('pdf');
    expect(result.nodes).toHaveLength(1);
    const body = result.nodes[0]?.markdown ?? '';

    expect(body).toContain('# Gateway runbook');
    expect(body).toContain('## Restarting');
    expect(body).toContain('## Limits');
    expect(body).toContain(
      'The gateway terminates TLS and forwards requests to the workers. It is restarted nightly, and the restart is logged.',
    );
    expect(body).toContain('```\nsystemctl restart gateway\n```');
    expect(body).toContain('| Setting | Value |');
    expect(body).toContain('| Timeout | 30s |');
  }, 30_000);

  it('always says the document was reconstructed', async () => {
    const result = await importFromPdf({
      pdf: RUNBOOK,
      documentTitle: 'gateway_runbook.pdf',
      limits: DEFAULT_IMPORT_LIMITS,
    });
    expect(result.nodes[0]?.warnings.map((warning) => warning.code)).toContain('reconstructed');
    expect(result.params['headings_from_font']).toBe(true);
  }, 30_000);

  it('takes its title from the file name, cleaned up', async () => {
    const result = await importFromPdf({
      pdf: RUNBOOK,
      documentTitle: 'gateway_runbook.pdf',
      limits: DEFAULT_IMPORT_LIMITS,
    });
    expect(result.nodes[0]?.title).toBe('gateway runbook');
  }, 30_000);

  it('gives each top-level heading its own page when asked to split', async () => {
    const pdf = buildPdf([
      [
        { text: 'First chapter', x: 72, y: 720, size: 20 },
        { text: 'Body of the first chapter.', x: 72, y: 690, size: 11 },
        { text: 'Second chapter', x: 72, y: 640, size: 20 },
        { text: 'Body of the second chapter.', x: 72, y: 610, size: 11 },
      ],
    ]);

    const result = await importFromPdf({
      pdf,
      documentTitle: 'manual.pdf',
      limits: DEFAULT_IMPORT_LIMITS,
      split: 'h1',
    });

    expect(result.nodes.map((node) => node.title)).toEqual(['manual', 'First chapter', 'Second chapter']);
    expect(result.nodes.slice(1).every((node) => node.parentSourceId === 'pdf:document')).toBe(true);
    expect(result.nodes[1]?.markdown).toContain('Body of the first chapter.');
  }, 30_000);

  it('refuses a PDF with no text, rather than importing empty pages', async () => {
    await expect(
      importFromPdf({
        pdf: buildPdf([[]]),
        documentTitle: 'scan.pdf',
        limits: DEFAULT_IMPORT_LIMITS,
      }),
    ).rejects.toThrow(/no extractable text/);
  }, 30_000);

  it('reads the reader through the injection point, so a fixture needs no engine', async () => {
    const result = await importFromPdf({
      pdf: new Uint8Array(0),
      documentTitle: 'stub.pdf',
      limits: DEFAULT_IMPORT_LIMITS,
      readItems: async () => ({
        totalPages: 1,
        items: [
          [
            { str: 'Title', x: 0, y: 100, width: 40, height: 18, fontSize: 18, fontFamily: 'sans-serif' },
            { str: 'Body.', x: 0, y: 80, width: 30, height: 10, fontSize: 10, fontFamily: 'sans-serif' },
          ],
        ],
      }),
    });
    expect(result.nodes[0]?.markdown).toBe('# Title\n\nBody.\n');
  });
});

describe('table confidence', () => {
  const line = (y: number, cells: Array<[number, string]>, size = 11) => ({
    y,
    size,
    monospaced: false,
    page: 0,
    text: cells.map(([, text]) => text).join(' '),
    items: cells.map(([x, text]) => ({ text, x, endX: x + text.length * 5 })),
  });

  it('reads aligned columns as a table', () => {
    const block = asTable([
      line(100, [
        [72, 'Setting'],
        [300, 'Value'],
      ]),
      line(84, [
        [72, 'Timeout'],
        [300, '30s'],
      ]),
      line(68, [
        [72, 'Retries'],
        [300, '3'],
      ]),
    ]);
    expect(block?.type).toBe('table');
  });

  it('emits preformatted text with a warning when the columns do not agree', () => {
    const block = asTable([
      line(100, [
        [72, 'Setting'],
        [300, 'Value'],
      ]),
      line(84, [
        [72, 'Timeout'],
        [180, '30s'],
        [420, 'per request'],
      ]),
      line(68, [
        [130, 'Retries'],
        [260, '3'],
      ]),
    ]);
    expect(block).toMatchObject({ type: 'preformatted', reason: 'low-confidence-table' });
  });

  it('attaches the low-confidence warning to the page it belongs to', async () => {
    const result = await importFromPdf({
      pdf: new Uint8Array(0),
      documentTitle: 'report.pdf',
      limits: DEFAULT_IMPORT_LIMITS,
      readItems: async () => ({
        totalPages: 1,
        items: [
          [
            { str: 'Setting', x: 72, y: 100, width: 30, height: 10, fontSize: 10, fontFamily: 'serif' },
            { str: 'Value', x: 300, y: 100, width: 25, height: 10, fontSize: 10, fontFamily: 'serif' },
            { str: 'Timeout', x: 72, y: 88, width: 30, height: 10, fontSize: 10, fontFamily: 'serif' },
            { str: '30s', x: 180, y: 88, width: 15, height: 10, fontSize: 10, fontFamily: 'serif' },
            { str: 'per request', x: 420, y: 88, width: 45, height: 10, fontSize: 10, fontFamily: 'serif' },
            { str: 'Retries', x: 130, y: 76, width: 28, height: 10, fontSize: 10, fontFamily: 'serif' },
            { str: '3', x: 260, y: 76, width: 6, height: 10, fontSize: 10, fontFamily: 'serif' },
          ],
        ],
      }),
    });
    expect(result.nodes[0]?.warnings.map((warning) => warning.code)).toContain('low-confidence-table');
    expect(result.nodes[0]?.markdown).toContain('```text');
  });
});

describe('line grouping', () => {
  it('joins items on the same baseline and orders them left to right', () => {
    const lines = groupLines(
      [
        { str: 'world', x: 40, y: 100, width: 30, height: 10, fontSize: 10, fontFamily: 'serif' },
        { str: 'Hello', x: 0, y: 100.2, width: 30, height: 10, fontSize: 10, fontFamily: 'serif' },
        { str: 'Next', x: 0, y: 80, width: 25, height: 10, fontSize: 10, fontFamily: 'serif' },
      ],
      0,
    );
    expect(lines.map((line) => line.text)).toEqual(['Hello world', 'Next']);
  });

  it('rejoins a word hyphenated across a line break', () => {
    const { blocks } = reconstruct(
      groupLines(
        [
          { str: 'config-', x: 0, y: 100, width: 40, height: 10, fontSize: 10, fontFamily: 'serif' },
          { str: 'uration file', x: 0, y: 88, width: 60, height: 10, fontSize: 10, fontFamily: 'serif' },
        ],
        0,
      ),
    );
    expect(blocks).toEqual([{ type: 'paragraph', text: 'configuration file' }]);
  });
});
