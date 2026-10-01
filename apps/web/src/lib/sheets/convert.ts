import 'server-only';

import { ImportError } from '@clewwiki/import';
import { parseDelimited, readXlsx, sheetsToMarkdown } from '@clewwiki/import/sheets';
import type { Sheet } from '@clewwiki/import/sheets';

import { cleanGoogleDocMarkdown, fetchGoogleExport, parseGoogleUrl } from './google';

/** What can be turned into page Markdown: a spreadsheet or a Google Doc. */
export const MAX_CONVERT_BYTES = 8 * 1024 * 1024;

export class ConvertError extends Error {
  constructor(
    readonly code: 'format' | 'unreadable' | 'notGoogle' | 'notPublic' | 'tooLarge' | 'unavailable' | 'empty',
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ConvertError';
  }
}

export interface Converted {
  markdown: string;
  sheets: Array<{ name: string; rows: number; columns: number }>;
  /** Images a Google Doc held that could not come along. */
  droppedImages: number;
}

function summary(sheets: Sheet[]): Converted['sheets'] {
  return sheets
    .filter((sheet) => sheet.rows.length > 0)
    .map((sheet) => ({ name: sheet.name, rows: sheet.rows.length, columns: sheet.rows[0]?.length ?? 0 }));
}

function fromSheets(sheets: Sheet[]): Converted {
  const markdown = sheetsToMarkdown(sheets);
  if (markdown.trim() === '') throw new ConvertError('empty');
  return { markdown, sheets: summary(sheets), droppedImages: 0 };
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/** A spreadsheet file by its name and, for a workbook, its signature. */
export function convertFile(name: string, bytes: Uint8Array): Converted {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  try {
    if (extension === 'xlsx' || extension === 'xlsm') {
      if (!ZIP_MAGIC.every((byte, index) => bytes[index] === byte)) throw new ConvertError('unreadable');
      return fromSheets(readXlsx(bytes));
    }
    if (extension === 'csv' || extension === 'tsv' || extension === 'txt') {
      const text = new TextDecoder('utf-8').decode(bytes);
      const rows = parseDelimited(text, extension === 'tsv' ? '\t' : undefined);
      return fromSheets([{ name: name.replace(/\.[^.]+$/, ''), rows }]);
    }
  } catch (error) {
    if (error instanceof ConvertError) throw error;
    if (error instanceof ImportError) throw new ConvertError('unreadable', error.message);
    throw error;
  }
  // The old binary .xls and .ods are not read; saying so beats a garbled table.
  throw new ConvertError('format');
}

export async function convertGoogleLink(link: string): Promise<Converted> {
  const document = parseGoogleUrl(link);
  if (!document) throw new ConvertError('notGoogle');
  let bytes: Uint8Array;
  try {
    bytes = await fetchGoogleExport(document, MAX_CONVERT_BYTES);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'notPublic' || code === 'tooLarge' || code === 'unavailable') throw new ConvertError(code);
    throw error;
  }
  if (document.kind === 'sheet') return convertFile('google-sheet.xlsx', bytes);
  const cleaned = cleanGoogleDocMarkdown(new TextDecoder('utf-8').decode(bytes));
  if (cleaned.markdown === '') throw new ConvertError('empty');
  return { markdown: cleaned.markdown, sheets: [], droppedImages: cleaned.droppedImages };
}
