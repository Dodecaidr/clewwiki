import { describe, expect, it } from 'vitest';
import {
  detectDelimiter,
  markdownTables,
  parseDelimited,
  readXlsx,
  sheetsToMarkdown,
  toCsv,
} from '@clewwiki/import/sheets';

import { cleanGoogleDocMarkdown, fetchGoogleExport, parseGoogleUrl } from '@/lib/sheets/google';
import { convertFile } from '@/lib/sheets/convert';
import { sheetNames, writeXlsx } from '@/lib/sheets/xlsx';
import { createZip } from '@/lib/spaces/zip';

/**
 * Spreadsheets in and out of pages: delimited text, Excel workbooks written by
 * other programs and by this one, the pipe tables of a page body, and reading
 * a Google document by its link without ever fetching a host the link chose.
 */

const text = (name: string, xml: string) => ({ name, data: new TextEncoder().encode(xml) });

/** A workbook as Excel writes one: shared strings, a date style, a hidden sheet, sparse cells. */
function excelStyleWorkbook(): Uint8Array {
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  return createZip([
    text('[Content_Types].xml', '<Types/>'),
    text(
      'xl/workbook.xml',
      `<workbook ${ns}><sheets><sheet name="Budget &amp; plan" sheetId="1" r:id="rId1"/><sheet name="Scratch" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`,
    ),
    text(
      'xl/_rels/workbook.xml.rels',
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    ),
    text(
      'xl/sharedStrings.xml',
      `<sst ${ns}><si><t>Item</t></si><si><t>Cost</t></si><si><r><t>Due</t></r><r><t xml:space="preserve"> date</t></r></si><si><t>Servers | racks</t></si></sst>`,
    ),
    text(
      'xl/styles.xml',
      `<styleSheet ${ns}><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
    ),
    text(
      'xl/worksheets/sheet1.xml',
      `<worksheet ${ns}><sheetData>` +
        '<row r="2"><c r="B2" t="s"><v>0</v></c><c r="C2" t="s"><v>1</v></c><c r="D2" t="s"><v>2</v></c><c r="E2" t="s"><v>0</v></c></row>' +
        '<row r="3"><c r="B3" t="s"><v>3</v></c><c r="C3"><v>1234.5</v></c><c r="D3" s="1"><v>45658</v></c><c r="E3" t="b"><v>1</v></c></row>' +
        '<row r="4"><c r="B4" t="inlineStr"><is><t>Licences</t></is></c><c r="C4"><f>C3*2</f><v>0.30000000000000004</v></c><c r="D4" s="2"><v>45658.5</v></c><c r="E4" t="str"><v>n/a</v></c></row>' +
        '<row r="6"/>' +
        '</sheetData></worksheet>',
    ),
    text('xl/worksheets/sheet2.xml', `<worksheet ${ns}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>secret</t></is></c></row></sheetData></worksheet>`),
  ]);
}

describe('delimited text', () => {
  it('finds the delimiter a file uses', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2')).toBe('\t');
    expect(detectDelimiter('a,b\n"x;y",2')).toBe(',');
  });

  it('reads quotes, doubled quotes, newlines in quotes and a byte-order mark', () => {
    expect(parseDelimited('﻿Name;Note\n"Ada";"said ""hi""\nthen left"\n\n')).toEqual([
      ['Name', 'Note'],
      ['Ada', 'said "hi"\nthen left'],
    ]);
  });

  it('pads ragged rows and drops empty trailing columns', () => {
    expect(parseDelimited('a,b,,\n1\n2,3,,', ',')).toEqual([
      ['a', 'b'],
      ['1', ''],
      ['2', '3'],
    ]);
  });

  it('writes CSV that reads back the same', () => {
    const rows = [['a', 'b,c'], ['"q"', 'line\nbreak']];
    expect(parseDelimited(toCsv(rows), ',')).toEqual(rows);
  });
});

describe('xlsx', () => {
  it('reads what a cell shows: shared and rich strings, numbers, dates, booleans, formula results', () => {
    const sheets = readXlsx(excelStyleWorkbook());
    // The hidden sheet is left out; the empty leading row and column are layout.
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Budget & plan']);
    expect(sheets[0]?.rows).toEqual([
      ['Item', 'Cost', 'Due date', 'Item'],
      ['Servers | racks', '1234.5', '2025-01-01', 'TRUE'],
      ['Licences', '0.3', '2025-01-01 12:00', 'n/a'],
    ]);
  });

  it('round-trips through its own writer, header bold, numbers as numbers', () => {
    const rows = [
      ['Name', 'Count', 'Code'],
      ['<b>&', '42', '007'],
      ['Ünïcode — ok', '-3.25', ''],
    ];
    const bytes = writeXlsx([{ name: 'Data', rows }, { name: 'data', rows: [['x']] }]);
    const back = readXlsx(bytes);
    expect(back.map((sheet) => sheet.name)).toEqual(['Data', 'data (2)']);
    expect(back[0]?.rows).toEqual(rows);
    const workbook = new TextDecoder().decode(bytes);
    expect(workbook).toContain('<c r="B2"><v>42</v></c>');
    expect(workbook).toContain('t="inlineStr"><is><t xml:space="preserve">007</t>');
  });

  it('keeps sheet names to what Excel accepts', () => {
    expect(sheetNames(['a/b:c', null, 'x'.repeat(40), 'X'.repeat(40)])).toEqual([
      'a b c',
      'Sheet2',
      'x'.repeat(31),
      `${'X'.repeat(27)} (2)`,
    ]);
  });

  it('refuses a file that only claims to be a workbook, and the old binary format', () => {
    expect(() => convertFile('report.xlsx', new TextEncoder().encode('not a zip'))).toThrow('unreadable');
    expect(() => convertFile('report.xls', new Uint8Array([0xd0, 0xcf]))).toThrow('format');
  });
});

describe('page tables', () => {
  it('turns sheets into tables headed by their names, and tables back into rows', () => {
    const markdown = sheetsToMarkdown([
      { name: 'People', rows: [['Name', 'Role'], ['Ada', 'eng | lead']] },
      { name: 'Empty', rows: [] },
      { name: 'Teams', rows: [['Team'], ['Core']] },
    ]);
    expect(markdown).toBe(
      '### People\n\n| Name | Role |\n| --- | --- |\n| Ada | eng \\| lead |\n\n### Teams\n\n| Team |\n| --- |\n| Core |',
    );
    expect(markdownTables(markdown)).toEqual([
      { title: 'People', rows: [['Name', 'Role'], ['Ada', 'eng | lead']] },
      { title: 'Teams', rows: [['Team'], ['Core']] },
    ]);
  });

  it('reads cell text without its formatting, and ignores tables inside code fences', () => {
    const body = [
      '```',
      '| not | a table |',
      '| --- | --- |',
      '```',
      '',
      '| **Bold** | Link |',
      '|:---|---:|',
      '| `x|y` | [docs](https://example.com) |',
      '| short |',
    ].join('\n');
    expect(markdownTables(body)).toEqual([
      { title: null, rows: [['Bold', 'Link'], ['x|y', 'docs'], ['short', '']] },
    ]);
  });

  it('notes the rows it leaves out of a very long sheet', () => {
    const rows = [['n'], ...Array.from({ length: 5 }, (_, index) => [String(index)])];
    expect(sheetsToMarkdown([{ name: 'Long', rows }], { maxRows: 2 })).toContain('*3 more rows were not inserted (limit 2).*');
  });
});

describe('Google links', () => {
  it('takes only a document id out of a docs.google.com link', () => {
    const id = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
    expect(parseGoogleUrl(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`)).toEqual({ kind: 'sheet', id });
    expect(parseGoogleUrl(`https://docs.google.com/document/u/1/d/${id}/edit`)).toEqual({ kind: 'doc', id });
    expect(parseGoogleUrl(`http://docs.google.com/spreadsheets/d/${id}`)).toBeNull();
    expect(parseGoogleUrl(`https://docs.google.com.evil.test/spreadsheets/d/${id}`)).toBeNull();
    expect(parseGoogleUrl(`https://evil.test/spreadsheets/d/${id}`)).toBeNull();
    expect(parseGoogleUrl('https://docs.google.com/spreadsheets/d/short')).toBeNull();
  });

  const id = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
  const respond = (status: number, init: { location?: string; type?: string; body?: string } = {}) =>
    new Response(init.body ?? null, {
      status,
      headers: { ...(init.location ? { location: init.location } : {}), 'content-type': init.type ?? 'application/octet-stream' },
    });

  it('follows Google’s redirect to its content host and nowhere else', async () => {
    const seen: string[] = [];
    const fetchOk = (async (url: string) => {
      seen.push(url);
      return seen.length === 1
        ? respond(307, { location: 'https://doc-0g-sheets.googleusercontent.com/export/abc' })
        : respond(200, { body: 'bytes' });
    }) as unknown as typeof fetch;
    const bytes = await fetchGoogleExport({ kind: 'sheet', id }, 1000, fetchOk);
    expect(new TextDecoder().decode(bytes)).toBe('bytes');
    expect(seen[0]).toBe(`https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`);

    const toElsewhere = (async () => respond(302, { location: 'https://169.254.169.254/latest' })) as unknown as typeof fetch;
    await expect(fetchGoogleExport({ kind: 'sheet', id }, 1000, toElsewhere)).rejects.toThrow('notPublic');
    const toLogin = (async () => respond(302, { location: 'https://accounts.google.com/ServiceLogin' })) as unknown as typeof fetch;
    await expect(fetchGoogleExport({ kind: 'doc', id }, 1000, toLogin)).rejects.toThrow('notPublic');
    const html = (async () => respond(200, { type: 'text/html', body: '<html>' })) as unknown as typeof fetch;
    await expect(fetchGoogleExport({ kind: 'doc', id }, 1000, html)).rejects.toThrow('notPublic');
    const big = (async () => respond(200, { body: 'x'.repeat(50) })) as unknown as typeof fetch;
    await expect(fetchGoogleExport({ kind: 'doc', id }, 10, big)).rejects.toThrow('tooLarge');
  });

  it('takes the embedded images out of a Google Doc export and counts them', () => {
    const exported = '# Title\n\n![][image1]\n\nText ![x](data:image/png;base64,AAA)\n\n[image1]: <data:image/png;base64,AAAA>\n';
    expect(cleanGoogleDocMarkdown(exported)).toEqual({ markdown: '# Title\n\nText', droppedImages: 2 });
  });
});
