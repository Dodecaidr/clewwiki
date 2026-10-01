import type { Sheet } from '@clewwiki/import/sheets';

import { createZip } from '../spaces/zip';

/**
 * Writes sheets as an Excel workbook (.xlsx): the smallest set of parts Excel,
 * LibreOffice, Numbers and Google Sheets all open — workbook, sheets, a style
 * sheet with a bold header row, and the relationships between them. Text goes
 * in as inline strings, so there is no shared-string table to keep in step.
 */

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function escapeXml(text: string): string {
  return (
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      // Control characters other than tab and newline are not allowed in XML 1.0.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  );
}

function columnName(index: number): string {
  let name = '';
  let rest = index + 1;
  while (rest > 0) {
    const remainder = (rest - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    rest = Math.floor((rest - 1) / 26);
  }
  return name;
}

/** A plain number Excel should treat as one; "007" and "1e5" stay text, as they were written. */
const NUMBER = /^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,15})?$/;

/** Excel's rules for a sheet name: 31 characters, none of []:*?/\, unique, case-insensitively. */
export function sheetNames(titles: Array<string | null>): string[] {
  const used = new Set<string>();
  return titles.map((title, index) => {
    const base = (title ?? '').replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || `Sheet${index + 1}`;
    let name = base;
    for (let suffix = 2; used.has(name.toLowerCase()); suffix += 1) {
      const tail = ` (${suffix})`;
      name = `${base.slice(0, 31 - tail.length)}${tail}`;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

function sheetXml(rows: string[][]): string {
  const body = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          if (value === '') return '';
          const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
          const style = rowIndex === 0 ? ' s="1"' : '';
          if (rowIndex > 0 && NUMBER.test(value)) return `<c r="${reference}"${style}><v>${value}</v></c>`;
          return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');
  // The header row stays in view while scrolling.
  const frozen =
    rows.length > 1
      ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      : '';
  return `${XML_HEAD}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">${frozen}<sheetData>${body}</sheetData></worksheet>`;
}

export function writeXlsx(sheets: Sheet[]): Uint8Array {
  const list = sheets.length > 0 ? sheets : [{ name: 'Sheet1', rows: [] }];
  const names = sheetNames(list.map((sheet) => sheet.name));
  const encoder = new TextEncoder();
  const text = (name: string, xml: string) => ({ name, data: encoder.encode(xml) });

  return createZip([
    text(
      '[Content_Types].xml',
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        list
          .map(
            (_, index) =>
              `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('') +
        '</Types>',
    ),
    text(
      '_rels/.rels',
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    text(
      'xl/workbook.xml',
      `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets>` +
        names.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('') +
        '</sheets></workbook>',
    ),
    text(
      'xl/_rels/workbook.xml.rels',
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        list
          .map(
            (_, index) =>
              `<Relationship Id="rId${index + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
          )
          .join('') +
        `<Relationship Id="rId${list.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`,
    ),
    text(
      'xl/styles.xml',
      `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}">` +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '</styleSheet>',
    ),
    ...list.map((sheet, index) => text(`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet.rows))),
  ]);
}
