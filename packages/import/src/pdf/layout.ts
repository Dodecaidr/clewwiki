/**
 * Reconstructing a document from the text a PDF actually contains.
 *
 * A PDF has no paragraphs, no headings and no tables. It has glyphs at
 * coordinates, in fonts, at sizes. Everything below is inference from those
 * four facts, and it is inference — the module is written to say how sure it is
 * rather than to pretend it knows, because an import that quietly mangles a
 * runbook is worse than one that says which parts it had to guess at.
 *
 * The steps, in order:
 *
 * 1. **Lines.** Items on roughly the same baseline become one line, ordered by
 *    x. "Roughly" is a fraction of the font size, because superscripts and
 *    inline maths sit slightly off the baseline of the text around them.
 * 2. **Body size.** The most common font size, weighted by how many characters
 *    are set in it. Everything else is measured against it.
 * 3. **Headings.** A line set larger than the body is a heading, and the
 *    distinct larger sizes, biggest first, become `#`, `##`, `###`. When a
 *    document has one size throughout — which is common in exported reports —
 *    the fallback is structural: a short line, not ending in sentence
 *    punctuation, followed by body text, or one that opens with a section
 *    number.
 * 4. **Paragraphs.** Consecutive body lines are joined, broken by a vertical
 *    gap noticeably larger than the line spacing. A word hyphenated across a
 *    line break is rejoined.
 * 5. **Tables.** Inside a run of lines, the gaps between items are looked at:
 *    when several lines break at the same x positions, that is a table. The
 *    fraction of lines that agree is the confidence, and a low one means the
 *    block is emitted as preformatted text with a warning rather than as a
 *    table that lost a column.
 * 6. **Code.** A run of lines set in a monospaced font stays monospaced, in a
 *    fence with no language.
 */

export interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontFamily: string;
}

export interface LineItem {
  text: string;
  x: number;
  /** x of the right edge, so a gap between items can be measured. */
  endX: number;
}

export interface Line {
  y: number;
  size: number;
  monospaced: boolean;
  items: LineItem[];
  text: string;
  page: number;
}

export type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; text: string }
  | { type: 'table'; header: string[]; rows: string[][]; confidence: number }
  | { type: 'preformatted'; text: string; reason: 'low-confidence-table' };

const MONOSPACED = /mono|courier|consol|menlo|inconsolata|source ?code/i;

/** Groups the items of one page into lines. */
export function groupLines(items: readonly TextItem[], page: number): Line[] {
  const usable = items.filter((item) => item.str.trim() !== '');
  const sorted = [...usable].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];

  for (const item of sorted) {
    const size = item.fontSize > 0 ? item.fontSize : item.height;
    const current = lines[lines.length - 1];
    const tolerance = Math.max(size * 0.4, 1);
    if (current && Math.abs(current.y - item.y) <= tolerance) {
      current.items.push({ text: item.str, x: item.x, endX: item.x + item.width });
      current.size = Math.max(current.size, size);
      current.monospaced = current.monospaced && MONOSPACED.test(item.fontFamily);
      continue;
    }
    lines.push({
      y: item.y,
      size,
      monospaced: MONOSPACED.test(item.fontFamily),
      items: [{ text: item.str, x: item.x, endX: item.x + item.width }],
      text: '',
      page,
    });
  }

  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.text = joinItems(line.items);
  }
  return lines.filter((line) => line.text.trim() !== '');
}

/**
 * Joins the items of a line, inserting a space where the gap between two of
 * them is wide enough that the PDF was not simply splitting a word.
 */
function joinItems(items: readonly LineItem[]): string {
  let out = '';
  let previous: LineItem | null = null;
  for (const item of items) {
    if (previous !== null && item.x - previous.endX > 0.8 && !out.endsWith(' ')) out += ' ';
    out += item.text;
    previous = item;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** The font size most of the document's characters are set in. */
export function bodySize(lines: readonly Line[]): number {
  const weights = new Map<number, number>();
  for (const line of lines) {
    const size = Math.round(line.size * 2) / 2;
    weights.set(size, (weights.get(size) ?? 0) + line.text.length);
  }
  let best = 0;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight || (weight === bestWeight && size < best)) {
      best = size;
      bestWeight = weight;
    }
  }
  return best === 0 ? 12 : best;
}

/** Heading sizes, largest first, so a size maps to a heading level. */
export function headingSizes(lines: readonly Line[], body: number): number[] {
  const sizes = new Set<number>();
  for (const line of lines) {
    const size = Math.round(line.size * 2) / 2;
    if (size > body * 1.12) sizes.add(size);
  }
  return [...sizes].sort((a, b) => b - a).slice(0, 5);
}

const SECTION_NUMBER = /^(?:\d+|[A-Z]|[IVXLC]+)(?:\.\d+)*[.)]?\s+\S/;
const SENTENCE_END = /[.!?;:,]$/;

export interface ReconstructOptions {
  /** Lines with fewer characters than this may be headings by the fallback rule. */
  shortLine?: number;
}

export interface Reconstruction {
  blocks: Block[];
  /** True when headings were found by font size rather than guessed. */
  headingsFromFont: boolean;
}

export function reconstruct(lines: readonly Line[], options: ReconstructOptions = {}): Reconstruction {
  const body = bodySize(lines);
  const sizes = headingSizes(lines, body);
  const shortLine = options.shortLine ?? 70;
  const blocks: Block[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;

    const level = headingLevel(line, lines, index, { body, sizes, shortLine });
    if (level !== null) {
      blocks.push({ type: 'heading', level, text: line.text });
      index += 1;
      continue;
    }

    if (line.monospaced) {
      const run: string[] = [];
      while (index < lines.length && lines[index]?.monospaced === true) {
        run.push(lines[index]?.text ?? '');
        index += 1;
      }
      blocks.push({ type: 'code', text: run.join('\n') });
      continue;
    }

    const run = takeRun(lines, index, { body, sizes, shortLine });
    const table = asTable(run.lines);
    if (table !== null) {
      blocks.push(table);
    } else {
      blocks.push(...paragraphs(run.lines, body));
    }
    index = run.nextIndex;
  }

  return { blocks, headingsFromFont: sizes.length > 0 };
}

interface HeadingContext {
  body: number;
  sizes: number[];
  shortLine: number;
}

/** The heading level of a line, or null when it is body text. */
export function headingLevel(
  line: Line,
  lines: readonly Line[],
  index: number,
  context: HeadingContext,
): number | null {
  const size = Math.round(line.size * 2) / 2;
  const rank = context.sizes.indexOf(size);
  if (rank !== -1) return Math.min(rank + 1, 6);
  if (context.sizes.length > 0) return null;

  // No size information to go on: the shape of the line has to decide.
  const text = line.text.trim();
  if (text.length === 0 || text.length > context.shortLine) return null;
  if (SENTENCE_END.test(text)) return null;
  const next = lines[index + 1];
  if (next === undefined || next.page !== line.page) return null;
  if (next.text.trim().length <= context.shortLine && !SECTION_NUMBER.test(text)) return null;

  if (SECTION_NUMBER.test(text)) {
    const depth = (text.match(/\./g) ?? []).length;
    return Math.min(depth + 1, 6);
  }
  // A line in capitals, or one that is plainly a label above a paragraph.
  if (text === text.toUpperCase() && /[A-ZА-Я]/.test(text)) return 2;
  return null;
}

/** Consecutive body lines, up to the next heading or the end of the document. */
function takeRun(
  lines: readonly Line[],
  start: number,
  context: HeadingContext,
): { lines: Line[]; nextIndex: number } {
  const run: Line[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.monospaced) break;
    if (index > start && headingLevel(line, lines, index, context) !== null) break;
    run.push(line);
    index += 1;
  }
  return { lines: run, nextIndex: Math.max(index, start + 1) };
}

/**
 * Splits a run of lines into paragraphs on the vertical gaps, joining words
 * hyphenated across a line break.
 */
export function paragraphs(lines: readonly Line[], body: number): Block[] {
  if (lines.length === 0) return [];
  const gaps: number[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1];
    const current = lines[index];
    if (previous && current && previous.page === current.page) gaps.push(previous.y - current.y);
  }
  const typical = median(gaps.filter((gap) => gap > 0)) || body * 1.2;

  const out: Block[] = [];
  let buffer: string[] = [];
  const flush = (): void => {
    const text = buffer.join(' ').replace(/\s+/g, ' ').trim();
    if (text !== '') out.push({ type: 'paragraph', text });
    buffer = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const previous = lines[index - 1];
    if (previous && previous.page === line.page && previous.y - line.y > typical * 1.6) flush();

    const last = buffer[buffer.length - 1];
    if (last !== undefined && /[‐-]$/.test(last)) {
      buffer[buffer.length - 1] = last.replace(/[‐-]$/, '') + line.text;
      continue;
    }
    buffer.push(line.text);
  }
  flush();
  return out;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

/** Past this a table is emitted as one; below it, as preformatted text. */
export const TABLE_CONFIDENCE_THRESHOLD = 0.7;

/**
 * A run of lines read as a table, or null when it is not one.
 *
 * The signal is agreement: the columns of a table start at the same x on every
 * row. Lines that break at those positions count towards the confidence, lines
 * that do not count against it.
 */
export function asTable(lines: readonly Line[]): Block | null {
  const candidates = lines.filter((line) => columnsOf(line).length >= 2);
  if (candidates.length < 2 || candidates.length < lines.length * 0.6) return null;

  const first = candidates[0];
  if (first === undefined) return null;
  const anchors = columnsOf(first).map((column) => column.x);
  const width = Math.max(...candidates.map((line) => columnsOf(line).length));

  let agreeing = 0;
  const rows: string[][] = [];
  for (const line of candidates) {
    const columns = columnsOf(line);
    const aligned = columns.filter((column) =>
      anchors.some((anchor) => Math.abs(anchor - column.x) <= 6),
    ).length;
    if (columns.length === width && aligned >= width - 1) agreeing += 1;
    rows.push(columns.map((column) => column.text));
  }

  const confidence = agreeing / candidates.length;
  if (confidence < TABLE_CONFIDENCE_THRESHOLD) {
    return {
      type: 'preformatted',
      text: lines.map((line) => line.text).join('\n'),
      reason: 'low-confidence-table',
    };
  }

  const [header = [], ...body] = rows;
  return { type: 'table', header, rows: body, confidence };
}

/** The cells of a line: item runs separated by a gap wide enough to be a column. */
export function columnsOf(line: Line): Array<{ x: number; text: string }> {
  const columns: Array<{ x: number; text: string }> = [];
  const gap = Math.max(line.size * 1.2, 6);
  let current: { x: number; endX: number; text: string } | null = null;

  for (const item of line.items) {
    if (current === null) {
      current = { x: item.x, endX: item.endX, text: item.text };
      continue;
    }
    if (item.x - current.endX > gap) {
      columns.push({ x: current.x, text: current.text.trim() });
      current = { x: item.x, endX: item.endX, text: item.text };
      continue;
    }
    current.text += (item.x - current.endX > 0.8 ? ' ' : '') + item.text;
    current.endX = item.endX;
  }
  if (current !== null) columns.push({ x: current.x, text: current.text.trim() });
  return columns.filter((column) => column.text !== '');
}
