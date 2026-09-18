/**
 * The PDF source.
 *
 * A PDF is a description of where to put ink, not a document with structure, so
 * this adapter is an approximation and says so everywhere it can: every page it
 * produces carries a `reconstructed` warning, the import lands in review like
 * every other, and the preview shows the reconstructed Markdown next to the
 * count of pages and the note about confidence. Nothing here is ever applied
 * without a person having read it.
 *
 * `unpdf` does the reading. It was chosen over the `pdfjs-dist` legacy build
 * for two reasons that matter here: it ships a serverless-targeted PDF.js with
 * no native module and no canvas dependency, so `pnpm install` stays a download
 * rather than a compile on every platform the container is built for; and its
 * `extractTextItems` hands back each run of text with its position, width, font
 * size and font family, which is exactly the input the reconstruction in
 * `./layout` needs. Extracting text through the plain `pdfjs-dist` API would
 * mean reaching into the page proxy for the same numbers by hand. The version
 * is pinned exactly, because a parser's output is the input to every heuristic
 * in this package and a patch release that changes spacing changes our results.
 */

import { ImportError } from '../limits';
import type { ImportLimits } from '../limits';
import { truncateToBytes, utf8Length } from '../limits';
import { codeBlock, escapeBlockText, finishBody, heading, joinBlocks, tableBlock } from '../markdown-out';
import { warn } from '../types';
import type { ImportNode, ImportParseResult, ImportWarning } from '../types';
import { groupLines, reconstruct } from './layout';
import type { Block, Line, TextItem } from './layout';

export * from './layout';

/** How the document is cut into pages. */
export type PdfSplitMode = 'single' | 'h1';

export interface PdfImportInput {
  pdf: Uint8Array;
  /** Shown as the document's title; the file name, usually. */
  documentTitle: string;
  limits: ImportLimits;
  /** `h1` gives each top-level heading its own page. Default `single`. */
  split?: PdfSplitMode;
  /** Replaces the reader in tests, so a fixture needs no PDF engine. */
  readItems?: PdfReader;
}

/** Reads a PDF into per-page text items. */
export type PdfReader = (pdf: Uint8Array) => Promise<{ totalPages: number; items: TextItem[][] }>;

/** The default reader: `unpdf`, imported lazily so a Markdown import never loads it. */
export const readWithUnpdf: PdfReader = async (pdf) => {
  const { extractTextItems } = await import('unpdf');
  try {
    // PDF.js takes ownership of the buffer it is given and detaches it, which
    // would leave the caller holding an empty array — and the same upload can
    // legitimately be read twice, once to preview and once to re-parse. It gets
    // a copy.
    const result = await extractTextItems(Uint8Array.from(pdf));
    return {
      totalPages: result.totalPages,
      items: result.items.map((page) =>
        page.map((item) => ({
          str: item.str,
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
          fontSize: item.fontSize,
          fontFamily: item.fontFamily,
        })),
      ),
    };
  } catch (error) {
    throw new ImportError('validation', 'The file could not be read as a PDF', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }
};

export async function importFromPdf(input: PdfImportInput): Promise<ImportParseResult> {
  const read = input.readItems ?? readWithUnpdf;
  const { totalPages, items } = await read(input.pdf);

  const lines: Line[] = [];
  for (let page = 0; page < items.length; page += 1) {
    lines.push(...groupLines(items[page] ?? [], page));
  }
  if (lines.length === 0) {
    throw new ImportError(
      'validation',
      'This PDF has no extractable text. A scan needs optical character recognition first, which this import does not do.',
    );
  }

  const { blocks, headingsFromFont } = reconstruct(lines);
  const title = cleanTitle(input.documentTitle) || firstHeading(blocks) || 'Imported document';
  const split = input.split ?? 'single';

  const sections = split === 'h1' ? splitByTopHeading(blocks) : [{ title: null, blocks }];
  if (sections.length > input.limits.pages) {
    throw new ImportError('validation', `This PDF would become more than ${input.limits.pages} pages`, {
      limit: input.limits.pages,
    });
  }

  const shared = (extra: ImportWarning[]): ImportWarning[] => [
    warn('reconstructed', headingsFromFont ? 'headings from font size' : 'headings from line shape'),
    ...extra,
  ];

  const nodes: ImportNode[] = [];
  const rootId = 'pdf:document';
  const rootBlocks = sections[0]?.title === null ? (sections[0]?.blocks ?? []) : [];
  const children = sections[0]?.title === null ? sections.slice(1) : sections;

  nodes.push(
    toNode({
      sourceId: rootId,
      parentSourceId: null,
      title,
      blocks: rootBlocks,
      ordering: 0,
      limits: input.limits,
      warnings: shared([]),
      allowEmpty: children.length > 0,
    }),
  );

  children.forEach((section, index) => {
    nodes.push(
      toNode({
        sourceId: `pdf:section:${index + 1}`,
        parentSourceId: rootId,
        title: section.title ?? `Section ${index + 1}`,
        blocks: section.blocks,
        ordering: index + 1,
        limits: input.limits,
        warnings: shared([]),
        allowEmpty: false,
      }),
    );
  });

  return {
    source: 'pdf',
    nodes,
    warnings: [warn('reconstructed', `${totalPages} PDF pages`)],
    params: {
      document_title: title,
      pdf_pages: totalPages,
      split,
      page_count: nodes.length,
      headings_from_font: headingsFromFont,
    },
  };
}

interface NodeInput {
  sourceId: string;
  parentSourceId: string | null;
  title: string;
  blocks: Block[];
  ordering: number;
  limits: ImportLimits;
  warnings: ImportWarning[];
  allowEmpty: boolean;
}

function toNode(input: NodeInput): ImportNode {
  const warnings = [...input.warnings];
  for (const block of input.blocks) {
    if (block.type === 'preformatted' && block.reason === 'low-confidence-table') {
      warnings.push(warn('low-confidence-table', firstLineOf(block.text)));
    }
  }

  let markdown = finishBody(renderBlocks(input.blocks));
  if (utf8Length(markdown) > input.limits.pageBytes) {
    markdown = truncateToBytes(markdown, input.limits.pageBytes);
    warnings.push(warn('truncated', input.title));
  }
  if (markdown.trim() === '' && !input.allowEmpty) warnings.push(warn('empty', input.title));

  return {
    sourceId: input.sourceId,
    parentSourceId: input.parentSourceId,
    title: input.title,
    kind: 'human',
    markdown,
    warnings,
    ordering: input.ordering,
  };
}

export function renderBlocks(blocks: readonly Block[]): string {
  return joinBlocks(
    blocks.map((block) => {
      switch (block.type) {
        case 'heading':
          return heading(block.level, escapeBlockText(block.text));
        case 'paragraph':
          return escapeBlockText(block.text);
        case 'code':
          return codeBlock(block.text);
        case 'table':
          return tableBlock(block.header, block.rows);
        case 'preformatted':
          // A block the reader could not read as a table keeps its alignment,
          // which is the only thing left that carries its meaning.
          return codeBlock(block.text, 'text');
      }
    }),
  );
}

/** Cuts the document at every top-level heading. */
function splitByTopHeading(blocks: readonly Block[]): Array<{ title: string | null; blocks: Block[] }> {
  const sections: Array<{ title: string | null; blocks: Block[] }> = [{ title: null, blocks: [] }];
  for (const block of blocks) {
    if (block.type === 'heading' && block.level === 1) {
      sections.push({ title: block.text, blocks: [] });
      continue;
    }
    sections[sections.length - 1]?.blocks.push(block);
  }
  // The lead-in before the first heading is the document's own page, and it
  // stays even when empty because the sections need a parent.
  return sections;
}

function firstHeading(blocks: readonly Block[]): string | null {
  for (const block of blocks) {
    if (block.type === 'heading') return block.text;
  }
  return null;
}

/** A file name read as a title: extension gone, separators as spaces. */
export function cleanTitle(value: string): string {
  return value
    .replace(/\.pdf$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstLineOf(value: string): string {
  return (value.split('\n')[0] ?? '').slice(0, 80);
}
