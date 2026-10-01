/**
 * Spreadsheets in and out of pages: CSV/TSV text, Excel workbooks (.xlsx) and
 * the pipe tables a page body holds.
 *
 * A workbook is a ZIP of XML parts, read here with the package's own ZIP reader
 * and a small tag scanner rather than a spreadsheet library — the same reasons
 * as for the reader itself: the input is untrusted, the part of the format that
 * matters is small (values, not formulas, charts or styling), and every bound
 * on what is expanded has to be this code's decision. What is read is the
 * value each cell shows: a formula's last computed result, a date as a date.
 */

import { ImportError } from '../limits';
import { tableBlock } from '../markdown-out';
import { entryText, readZip } from '../zip';

export interface Sheet {
  name: string;
  /** Rows of cell text, the first being the header. Ragged rows are padded. */
  rows: string[][];
}

export interface SheetLimits {
  /** Bytes the workbook may expand to. */
  expandedBytes: number;
  sheets: number;
  /** Cells across all sheets, empty ones not counted. */
  cells: number;
}

export const DEFAULT_SHEET_LIMITS: SheetLimits = {
  expandedBytes: 64 * 1024 * 1024,
  sheets: 50,
  cells: 200_000,
};

/* ------------------------------------------------------------------ */
/* Delimited text                                                      */
/* ------------------------------------------------------------------ */

/**
 * The delimiter a file most likely uses: whichever of tab, semicolon and comma
 * splits the first lines most consistently. A Russian or German Excel saves
 * "CSV" with semicolons, so a comma cannot simply be assumed.
 */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim() !== '').slice(0, 10);
  let best: ',' | ';' | '\t' = ',';
  let bestScore = 0;
  for (const candidate of ['\t', ';', ','] as const) {
    const counts = lines.map((line) => line.split(candidate).length - 1);
    const first = counts[0] ?? 0;
    if (first === 0) continue;
    const consistent = counts.filter((count) => count === first).length;
    const score = consistent * 1000 + first;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** RFC 4180 with any one-character delimiter: quotes doubled inside quotes, newlines allowed in them. */
export function parseDelimited(text: string, delimiter: string = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;

  const endField = (): void => {
    row.push(field);
    field = '';
    started = false;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  const source = text.replace(/^﻿/, '');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && !started) {
      quoted = true;
      started = true;
      continue;
    }
    if (char === delimiter) {
      endField();
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      endRow();
      continue;
    }
    field += char;
    started = true;
  }
  if (field !== '' || row.length > 0) endRow();
  return tidy(rows);
}

/** Writes rows as RFC 4180 CSV, quoting only what has to be. */
export function toCsv(rows: string[][], delimiter = ','): string {
  const needsQuotes = new RegExp(`["\\r\\n${delimiter === '\t' ? '\\t' : delimiter}]`);
  return rows
    .map((row) =>
      row.map((cell) => (needsQuotes.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(delimiter),
    )
    .join('\r\n');
}

/** Drops trailing empty rows and columns, and pads every row to the same width. */
function tidy(rows: string[][]): string[][] {
  const kept = [...rows];
  while (kept.length > 0 && (kept[kept.length - 1] ?? []).every((cell) => cell.trim() === '')) kept.pop();
  let width = 0;
  for (const row of kept) {
    for (let column = row.length - 1; column >= 0; column -= 1) {
      if ((row[column] ?? '').trim() !== '') {
        width = Math.max(width, column + 1);
        break;
      }
    }
  }
  return kept.map((row) => Array.from({ length: width }, (_, column) => row[column] ?? ''));
}

/* ------------------------------------------------------------------ */
/* XLSX                                                                */
/* ------------------------------------------------------------------ */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s(?:\\w+:)?${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  if (!match) return null;
  return decodeXml(match[2] ?? match[3] ?? '');
}

/** The text of every `<t>` inside `xml`, joined; phonetic runs (`<rPh>`) left out. */
function textRuns(xml: string): string {
  const withoutPhonetic = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '');
  let out = '';
  for (const match of withoutPhonetic.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)) {
    out += decodeXml(match[1] ?? '');
  }
  return out;
}

/** "AB12" → 27 (zero-based column of the reference). */
function columnOf(reference: string): number {
  const letters = /^[A-Z]+/i.exec(reference)?.[0]?.toUpperCase() ?? '';
  let column = 0;
  for (const letter of letters) column = column * 26 + (letter.charCodeAt(0) - 64);
  return column - 1;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Whether a number format shows a date or a time: it has d/m/y/h/s outside quotes and brackets. */
function isDateFormat(code: string): boolean {
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dmyhs]/i.test(bare) && !/^[#0.,%\s]*$/.test(bare);
}

function formatNumber(raw: string): string {
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;
  // Fifteen significant digits is what a spreadsheet shows; it also hides the
  // binary noise in values such as 0.1 + 0.2.
  return String(Number(value.toPrecision(15)));
}

function formatDate(serial: number, date1904: boolean): string {
  const days = serial + (date1904 ? 1462 : 0);
  const millis = Math.round((days - 25569) * 86_400_000);
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return String(serial);
  const iso = date.toISOString();
  const hasTime = Math.abs(days - Math.floor(days)) > 1e-9;
  // A pure time (serial below one) keeps only the clock.
  if (serial < 1 && hasTime) return iso.slice(11, 16);
  return hasTime ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

function resolvePart(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.' && segment !== '') parts.push(segment);
  }
  return parts.join('/');
}

/** Every sheet of an `.xlsx` workbook as rows of displayed text. */
export function readXlsx(bytes: Uint8Array, limits: SheetLimits = DEFAULT_SHEET_LIMITS): Sheet[] {
  const files = new Map(
    readZip(bytes, {
      limits: { expandedBytes: limits.expandedBytes, zipEntries: 10_000 },
      accept: (name) => /^xl\/.*\.(xml|rels)$/i.test(name) || name === '[Content_Types].xml',
    }).map((file) => [file.name, entryText(file)]),
  );
  const workbook = files.get('xl/workbook.xml');
  if (workbook === undefined) throw new ImportError('validation', 'The file is not an Excel workbook (.xlsx)');

  const date1904 = /<(?:\w+:)?workbookPr\b[^>]*\bdate1904\s*=\s*["'](?:1|true)["']/.test(workbook);
  const relations = new Map<string, string>();
  for (const match of (files.get('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
    const id = attribute(match[0], 'Id');
    const target = attribute(match[0], 'Target');
    if (id && target) relations.set(id, resolvePart('xl/workbook.xml', target));
  }

  const shared: string[] = [];
  for (const match of (files.get('xl/sharedStrings.xml') ?? '').matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)) {
    shared.push(textRuns(match[1] ?? ''));
  }

  // Which cell styles show a date: style index → number format → is it a date.
  const styles = files.get('xl/styles.xml') ?? '';
  const customFormats = new Map<number, string>();
  for (const match of styles.matchAll(/<(?:\w+:)?numFmt\b[^>]*>/g)) {
    const id = Number(attribute(match[0], 'numFmtId'));
    const code = attribute(match[0], 'formatCode');
    if (Number.isFinite(id) && code !== null) customFormats.set(id, code);
  }
  const dateStyles = new Set<number>();
  const cellXfs = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(styles)?.[1] ?? '';
  let styleIndex = 0;
  for (const match of cellXfs.matchAll(/<(?:\w+:)?xf\b[^>]*>/g)) {
    const formatId = Number(attribute(match[0], 'numFmtId') ?? '0');
    const custom = customFormats.get(formatId);
    if (BUILTIN_DATE_FORMATS.has(formatId) || (custom !== undefined && isDateFormat(custom))) dateStyles.add(styleIndex);
    styleIndex += 1;
  }

  const sheets: Sheet[] = [];
  let cells = 0;
  for (const match of workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    if (sheets.length >= limits.sheets) {
      throw new ImportError('validation', `The workbook has more than ${limits.sheets} sheets`);
    }
    const name = attribute(match[0], 'name') ?? `Sheet ${sheets.length + 1}`;
    // Hidden sheets are working space, not content.
    const state = attribute(match[0], 'state');
    if (state === 'hidden' || state === 'veryHidden') continue;
    const relation = attribute(match[0], 'id');
    const part = relation ? relations.get(relation) : undefined;
    const xml = part ? files.get(part) : undefined;
    if (xml === undefined) continue;

    const rows: string[][] = [];
    let nextRow = 0;
    for (const rowMatch of xml.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
      const declared = Number(attribute(`<row ${rowMatch[1] ?? ''}>`, 'r'));
      const rowIndex = Number.isFinite(declared) && declared > 0 ? declared - 1 : nextRow;
      nextRow = rowIndex + 1;
      // Rows far below the data (a stray formatted cell at row 1 048 576) would
      // otherwise make a million empty rows.
      if (rowIndex - rows.length > 10_000) break;
      while (rows.length <= rowIndex) rows.push([]);
      const row = rows[rowIndex] ?? [];
      let nextColumn = 0;
      for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const tag = `<c ${cellMatch[1] ?? ''}>`;
        const reference = attribute(tag, 'r');
        const column = reference ? columnOf(reference) : nextColumn;
        nextColumn = column + 1;
        if (column > 16_383) continue;
        const inner = cellMatch[2] ?? '';
        const type = attribute(tag, 't') ?? 'n';
        const raw = decodeXml(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1] ?? '');
        let text: string;
        if (type === 's') text = shared[Number(raw)] ?? '';
        else if (type === 'inlineStr') text = textRuns(inner);
        else if (type === 'b') text = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
        else if (type === 'str' || type === 'e' || type === 'd') text = raw;
        else if (raw === '') text = '';
        else {
          const style = Number(attribute(tag, 's') ?? '0');
          text = dateStyles.has(style) && Number.isFinite(Number(raw)) ? formatDate(Number(raw), date1904) : formatNumber(raw);
        }
        if (text === '') continue;
        cells += 1;
        if (cells > limits.cells) {
          throw new ImportError('validation', `The workbook has more than ${limits.cells} filled cells`);
        }
        while (row.length <= column) row.push('');
        row[column] = text;
      }
      rows[rowIndex] = row;
    }
    // A leading empty row or column is layout, not data.
    const tidied = tidy(rows);
    while (tidied.length > 0 && (tidied[0] ?? []).every((cell) => cell.trim() === '')) tidied.shift();
    let lead = 0;
    while (tidied.length > 0 && tidied.every((row) => (row[lead] ?? '').trim() === '') && lead < (tidied[0]?.length ?? 0)) {
      lead += 1;
    }
    sheets.push({ name, rows: tidied.map((row) => row.slice(lead)) });
  }
  return sheets;
}

/* ------------------------------------------------------------------ */
/* To and from page Markdown                                           */
/* ------------------------------------------------------------------ */

export interface SheetMarkdownOptions {
  /** Rows kept per sheet; the rest are counted in a note below the table. */
  maxRows?: number;
  /** Whether each table is headed by its sheet's name. Off for a single sheet. */
  headings?: boolean;
}

/** GFM tables, one per non-empty sheet, the first row of each as its header. */
export function sheetsToMarkdown(sheets: Sheet[], options: SheetMarkdownOptions = {}): string {
  const maxRows = options.maxRows ?? 2_000;
  const filled = sheets.filter((sheet) => sheet.rows.length > 0);
  const headings = options.headings ?? filled.length > 1;
  return filled
    .map((sheet) => {
      const [header = [], ...body] = sheet.rows;
      const kept = body.slice(0, maxRows);
      const parts: string[] = [];
      if (headings) parts.push(`### ${sheet.name.replace(/[\r\n]+/g, ' ').trim()}`);
      parts.push(tableBlock(header, kept));
      if (body.length > kept.length) {
        parts.push(`*${body.length - kept.length} more rows were not inserted (limit ${maxRows}).*`);
      }
      return parts.join('\n\n');
    })
    .join('\n\n');
}

export interface MarkdownTable {
  /** The nearest heading above the table, if any — a sheet name on export. */
  title: string | null;
  rows: string[][];
}

/** Splits one pipe-table line into cells, honouring `\|` and code spans. */
function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  let inCode = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '\\' && body[index + 1] === '|') {
      cell += '|';
      index += 1;
      continue;
    }
    if (char === '`') inCode = !inCode;
    if (char === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

const DELIMITER_ROW = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** Inline Markdown reduced to the text a spreadsheet cell should hold. */
function plainCell(cell: string): string {
  return cell
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[^*\w])[*_]([^*_]+)[*_](?=[^*\w]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1');
}

/** Every GFM pipe table of a page body, outside code fences, as plain cell text. */
export function markdownTables(markdown: string): MarkdownTable[] {
  const lines = markdown.split(/\r?\n/);
  const tables: MarkdownTable[] = [];
  let fence: string | null = null;
  let heading: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? '';
      if (fence === null) fence = marker;
      else if (marker.startsWith(fence[0] ?? '') && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const headingMatch = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (headingMatch) {
      heading = headingMatch[1] ?? null;
      continue;
    }
    const next = lines[index + 1] ?? '';
    if (!line.includes('|') || !DELIMITER_ROW.test(next)) continue;
    const header = splitRow(line);
    const rows: string[][] = [header.map(plainCell)];
    index += 2;
    while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim() !== '') {
      const cells = splitRow(lines[index] ?? '');
      rows.push(Array.from({ length: header.length }, (_, column) => plainCell(cells[column] ?? '')));
      index += 1;
    }
    index -= 1;
    tables.push({ title: heading, rows });
  }
  return tables;
}
