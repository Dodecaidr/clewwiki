/**
 * The CSV a Notion export writes beside every database.
 *
 * A small table is worth inlining as GFM, which is what the database looked
 * like in Notion. A large one is not: a thousand-row table in a wiki page is
 * unreadable and it is not what the database was for, so past a threshold the
 * page says how big it was and the reviewer decides what to do with it.
 *
 * The parser is RFC 4180: comma-separated, quotes doubled inside quotes,
 * newlines allowed inside quoted fields.
 */

export interface CsvTable {
  header: string[];
  rows: string[][];
}

export function parseCsv(text: string): CsvTable {
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
    if (char === ',') {
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

  // A trailing newline leaves one empty row behind.
  while (rows.length > 0 && (rows[rows.length - 1] ?? []).every((cell) => cell.trim() === '')) {
    rows.pop();
  }

  const [header = [], ...body] = rows;
  return { header, rows: body };
}

/** Past either of these a table is linked rather than inlined. */
export const MAX_INLINE_ROWS = 100;
export const MAX_INLINE_COLUMNS = 12;

export function isInlineable(table: CsvTable): boolean {
  return table.rows.length <= MAX_INLINE_ROWS && table.header.length <= MAX_INLINE_COLUMNS;
}
