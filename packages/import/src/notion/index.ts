/**
 * The Notion export source.
 *
 * Input is the ZIP of "Export as Markdown & CSV", with or without subpages.
 * Notion's Markdown is close to GFM already, so most of this adapter is about
 * the four places it is not:
 *
 * - **Names.** Every file and folder ends in the 32-hex page id — `Runbook
 *   a1b2c3….md` — which must not become part of a title or a path.
 * - **Callouts.** Notion writes a callout as a blockquote led by an emoji.
 *   Those become GitHub alerts, with the emoji deciding which kind.
 * - **Toggles.** A toggle is a `<details>` element, and page bodies do not
 *   render raw HTML. It becomes a bold summary followed by its content, and the
 *   page carries a warning saying the fold is gone.
 * - **Databases.** A database is a CSV beside a folder of row pages. A small
 *   one becomes a GFM table on the database's own page; a large one becomes a
 *   line saying how large it was, and the row pages are imported regardless.
 */

import { ImportError } from '../limits';
import type { ImportLimits } from '../limits';
import { truncateToBytes, utf8Length } from '../limits';
import { calloutBlock, finishBody, joinBlocks, tableBlock } from '../markdown-out';
import { warn } from '../types';
import type { ImportParseResult, ImportWarning } from '../types';
import {
  basenameOf,
  buildDocumentTree,
  extensionOf,
  keyForDocument,
  rewriteRelativeLinks,
  takeLeadingHeading,
} from '../doctree';
import type { DocumentPage } from '../doctree';
import { commonPrefix, titleFromName } from '../markdown/index';
import { entryText, readZip } from '../zip';
import { isInlineable, parseCsv } from './csv';

export * from './csv';

/** The page id Notion appends to every exported name. */
const NOTION_ID = /[ _-]([0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;

/** Strips the export's hash suffix from one path segment. */
export function stripNotionId(segment: string): string {
  return segment.replace(NOTION_ID, '').trim();
}

/** The same, applied to every segment of a path, extension kept. */
export function stripNotionPath(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      const dot = segment.lastIndexOf('.');
      if (dot <= 0) return stripNotionId(segment);
      return stripNotionId(segment.slice(0, dot)) + segment.slice(dot);
    })
    .join('/');
}

/** Notion's callout emoji, and the alert each one means. */
const CALLOUT_EMOJI: ReadonlyArray<{ pattern: RegExp; kind: 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION' }> = [
  { pattern: /^(?:⚠️?|🚨)/u, kind: 'WARNING' },
  { pattern: /^(?:❌|🛑)/u, kind: 'CAUTION' },
  { pattern: /^(?:💡|✨)/u, kind: 'TIP' },
  { pattern: /^(?:❗|‼️?|🔥)/u, kind: 'IMPORTANT' },
];

export interface NotionImportInput {
  zip: Uint8Array;
  limits: ImportLimits;
}

export function importFromNotionZip(input: NotionImportInput): ImportParseResult {
  const entries = readZip(input.zip, { limits: input.limits });
  const usable = entries.filter((entry) => {
    const extension = extensionOf(entry.name);
    return (extension === 'md' || extension === 'csv') && !entry.name.includes('__MACOSX/');
  });

  if (usable.length === 0) {
    throw new ImportError('validation', 'The archive holds no Notion Markdown or CSV files');
  }

  const prefix = commonPrefix(usable.map((entry) => entry.name));
  // `_all.csv` is the same database a second time, with every view flattened.
  // One copy is enough.
  const files = usable
    .map((entry) => ({ entry, path: stripNotionPath(entry.name.slice(prefix.length)) }))
    .filter(({ path }) => !/_all\.csv$/i.test(path));

  const markdownFiles = files.filter(({ path }) => extensionOf(path) === 'md');
  if (markdownFiles.length > input.limits.pages) {
    throw new ImportError('validation', `The export holds more than ${input.limits.pages} pages`, {
      limit: input.limits.pages,
    });
  }

  // A database's CSV and its folder of row pages share a name, so the CSV
  // becomes the folder's own page and the rows land below it.
  const known = new Set(files.map(({ path }) => keyForDocument(path)));
  const warnings: ImportWarning[] = [];

  const pages: DocumentPage[] = files.map(({ entry, path }, index) => {
    const pageWarnings: ImportWarning[] = [];
    const isCsv = extensionOf(path) === 'csv';
    const raw = entryText(entry);

    const converted = isCsv
      ? convertDatabase(raw, basenameOf(path), pageWarnings)
      : convertNotionMarkdown(raw, pageWarnings);

    const lead = isCsv ? { title: null, body: converted } : takeLeadingHeading(converted);
    // A link still carries the export's hash suffixes; the keys no longer do.
    const rewritten = rewriteRelativeLinks(lead.body, path, (target) => {
      const key = keyForDocument(stripNotionPath(target));
      return known.has(key) ? key : null;
    });
    pageWarnings.push(...rewritten.warnings);

    let markdown = finishBody(rewritten.markdown);
    if (utf8Length(markdown) > input.limits.pageBytes) {
      markdown = truncateToBytes(markdown, input.limits.pageBytes);
      pageWarnings.push(warn('truncated', path));
    }
    if (markdown.trim() === '') pageWarnings.push(warn('empty', path));

    return {
      key: keyForDocument(path),
      title: lead.title ?? titleFromName(basenameOf(path)),
      markdown,
      warnings: pageWarnings,
      sourcePath: path,
      modifiedAt: entry.modifiedAt,
      ordering: index,
    };
  });

  const tree = buildDocumentTree(pages, { sectionTitle: titleFromName });

  return {
    source: 'notion',
    nodes: tree.nodes,
    warnings,
    params: {
      file_count: files.length,
      page_count: markdownFiles.length,
      database_count: files.length - markdownFiles.length,
    },
  };
}

/**
 * The Notion dialect, brought into this project's.
 *
 * Nothing here parses Markdown: each fix is a line-level rewrite applied
 * outside fenced code, because a code block that happens to contain `<details>`
 * is code, not a toggle.
 */
export function convertNotionMarkdown(source: string, warnings: ImportWarning[]): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let fence: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch?.[1]) {
      if (fence === null) fence = fenceMatch[1][0] ?? null;
      else if (line.trimStart().startsWith(fence)) fence = null;
      out.push(line);
      continue;
    }
    if (fence !== null) {
      out.push(line);
      continue;
    }

    if (/^\s*<details>\s*$/i.test(line)) {
      const block = takeToggle(lines, index);
      warnings.push(warn('toggle-converted', block.summary || 'toggle'));
      out.push(...block.lines);
      index = block.nextIndex;
      continue;
    }

    const callout = calloutAt(lines, index);
    if (callout !== null) {
      out.push(callout.markdown);
      index = callout.nextIndex;
      continue;
    }

    out.push(line);
  }

  return out.join('\n');
}

/**
 * A Notion toggle: `<details><summary>…</summary>` then its content. The
 * renderer drops raw HTML, so the fold becomes a bold line and the content
 * stays where it was, visible.
 */
function takeToggle(
  lines: readonly string[],
  start: number,
): { lines: string[]; summary: string; nextIndex: number } {
  let summary = '';
  const body: string[] = [];
  let index = start + 1;

  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\s*<\/details>\s*$/i.test(line)) break;
    const match = /^\s*<summary>([\s\S]*?)<\/summary>\s*$/i.exec(line);
    if (match) {
      summary = (match[1] ?? '').trim();
      continue;
    }
    body.push(line);
  }

  const heading = summary === '' ? '**Details**' : `**${summary}**`;
  return { lines: [heading, '', ...body], summary, nextIndex: index };
}

/**
 * A Notion callout: a blockquote whose first line opens with an emoji. The
 * emoji chooses the alert; without a recognised one it becomes a plain note.
 */
function calloutAt(
  lines: readonly string[],
  start: number,
): { markdown: string; nextIndex: number } | null {
  const first = lines[start] ?? '';
  const opener = /^>\s*(\p{Extended_Pictographic}️?)\s*(.*)$/u.exec(first);
  if (!opener) return null;

  const body: string[] = [(opener[2] ?? '').trim()];
  let index = start;
  while (index + 1 < lines.length && /^>/.test(lines[index + 1] ?? '')) {
    index += 1;
    body.push((lines[index] ?? '').replace(/^>\s?/, ''));
  }

  const emoji = opener[1] ?? '';
  const kind = CALLOUT_EMOJI.find(({ pattern }) => pattern.test(emoji))?.kind ?? 'NOTE';
  return { markdown: calloutBlock(kind, body.join('\n').trim()), nextIndex: index };
}

/** A database CSV: a table when it is small enough to read, a note when it is not. */
function convertDatabase(csv: string, name: string, warnings: ImportWarning[]): string {
  const table = parseCsv(csv);
  if (table.header.length === 0) {
    warnings.push(warn('empty', name));
    return '';
  }
  if (isInlineable(table)) {
    return tableBlock(table.header, table.rows);
  }

  warnings.push(warn('database-too-large', `${table.rows.length} rows`));
  return joinBlocks([
    calloutBlock(
      'NOTE',
      `This Notion database had ${table.rows.length} rows and ${table.header.length} columns, which is more than a page holds readably. Its columns were: ${table.header.join(', ')}. The rows were exported as pages below this one.`,
    ),
  ]);
}
