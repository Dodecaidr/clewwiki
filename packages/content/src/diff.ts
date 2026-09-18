/**
 * A line diff between two versions of a page body, for a person reviewing what
 * somebody else — usually an agent — changed.
 *
 * The comparison is by line, because a page is Markdown and Markdown is written
 * and reviewed in lines; inside a line that was rewritten rather than added or
 * removed, the words that changed are marked, so a one-word fix in a long
 * paragraph reads as a one-word fix.
 *
 * The algorithm is Myers' O(ND) shortest edit script. It is written here rather
 * than imported because the whole of it is a hundred lines, and because both
 * texts come from a caller: the work it may do is bounded explicitly
 * (`MAX_EDIT_DISTANCE`, `MAX_DIFF_LINES`) instead of being whatever a dependency
 * happens to do with two unrelated 10 MB bodies. Past those bounds the result
 * is *coarse* — everything between the common head and the common tail is
 * reported as removed and added — and says so, which is still a correct diff,
 * only not a minimal one.
 *
 * Nothing here knows about pages, versions or HTML. The output is data, and
 * whoever renders it escapes it.
 */

/** Lines of unchanged text shown around a change. */
export const DEFAULT_CONTEXT_LINES = 3;

/**
 * The largest edit distance searched for. The trace kept for backtracking grows
 * with its square, so 2 000 is about 16 MB at the very worst; a pair of texts
 * further apart than that is a rewrite, and a minimal script of a rewrite is of
 * no use to a reader anyway.
 */
export const MAX_EDIT_DISTANCE = 2_000;

/** Most lines, both sides together and after trimming, compared line by line. */
export const MAX_DIFF_LINES = 40_000;

/**
 * A rewritten line is compared word by word only when both sides are this short
 * and at least this much of the line survived; otherwise marking "what changed"
 * would mark nearly everything and help nobody.
 */
const MAX_INLINE_LENGTH = 2_000;
const MIN_INLINE_SIMILARITY = 0.4;

export type DiffLineKind = 'context' | 'added' | 'removed';

/** A run of characters inside a changed line. */
export interface DiffSegment {
  text: string;
  /** True for the part that differs from the line it is paired with. */
  changed: boolean;
}

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based line number in the old text; null for an added line. */
  oldNumber: number | null;
  /** 1-based line number in the new text; null for a removed line. */
  newNumber: number | null;
  /** Present only on a removed/added pair that was compared word by word. */
  segments?: DiffSegment[];
}

/** A group of changes with the unchanged lines around them. */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffStats {
  added: number;
  removed: number;
}

export interface TextDiff {
  /** True when the two texts are the same string. */
  identical: boolean;
  /**
   * True when the texts differ but no line does — the only difference is in
   * line endings: a final line break, or `\r\n` against `\n`.
   */
  onlyLineEndings: boolean;
  /** True when the bounds were hit and the script is correct but not minimal. */
  coarse: boolean;
  stats: DiffStats;
  hunks: DiffHunk[];
}

export interface DiffOptions {
  /** Unchanged lines kept around each change. Defaults to three. */
  context?: number;
}

type EditKind = 'equal' | 'insert' | 'delete';

interface Edit {
  kind: EditKind;
  /** Index into the old sequence; -1 for an insert. */
  oldIndex: number;
  /** Index into the new sequence; -1 for a delete. */
  newIndex: number;
}

/**
 * Splits a text into lines. A final line break ends the last line rather than
 * starting an empty one, so `"a\n"` and `"a"` are both one line — the
 * difference between them is reported by `onlyLineEndings`, not as a phantom
 * empty line. A `\r` before the break belongs to the break.
 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/**
 * Myers' shortest edit script between two sequences, or null when it is longer
 * than `limit` edits.
 *
 * `v[k]` is the furthest x reached on diagonal k. After each round only the
 * diagonals that round could touch, `-d … d`, are kept for the way back, which
 * is what makes the trace quadratic in the distance and not in the input.
 */
function shortestEditScript(
  before: readonly string[],
  after: readonly string[],
  limit: number,
): Edit[] | null {
  const n = before.length;
  const m = after.length;
  const max = n + m;
  if (max === 0) return [];

  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  const rounds = Math.min(max, limit);

  let distance = -1;
  for (let d = 0; d <= rounds && distance < 0; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!);
      let x = down ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        distance = d;
        break;
      }
    }
    if (distance < 0) trace.push(v.slice(offset - d, offset + d + 1));
  }
  if (distance < 0) return null;

  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = distance; d > 0; d -= 1) {
    const previous = trace[d - 1]!;
    const at = (k: number): number => previous[k + d - 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      edits.push({ kind: 'equal', oldIndex: x, newIndex: y });
    }
    if (down) {
      y -= 1;
      edits.push({ kind: 'insert', oldIndex: -1, newIndex: y });
    } else {
      x -= 1;
      edits.push({ kind: 'delete', oldIndex: x, newIndex: -1 });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    edits.push({ kind: 'equal', oldIndex: x, newIndex: y });
  }
  return edits.reverse();
}

/**
 * The edit script of two sequences, always. The common head and tail are set
 * aside first — an edit to one paragraph of a long page leaves the search a
 * handful of lines — and when what remains is past the bounds, it is reported
 * as removed and then added.
 */
function editScript(
  before: readonly string[],
  after: readonly string[],
  limit: number,
  maxItems: number,
): { edits: Edit[]; coarse: boolean } {
  let head = 0;
  const shortest = Math.min(before.length, after.length);
  while (head < shortest && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < shortest - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }

  const middleBefore = before.slice(head, before.length - tail);
  const middleAfter = after.slice(head, after.length - tail);

  let coarse = false;
  let middle: Edit[] | null = null;
  if (middleBefore.length + middleAfter.length <= maxItems) {
    middle = shortestEditScript(middleBefore, middleAfter, limit);
  }
  if (middle === null) {
    coarse = middleBefore.length > 0 && middleAfter.length > 0;
    middle = [
      ...middleBefore.map((_, index): Edit => ({ kind: 'delete', oldIndex: index, newIndex: -1 })),
      ...middleAfter.map((_, index): Edit => ({ kind: 'insert', oldIndex: -1, newIndex: index })),
    ];
  }

  const edits: Edit[] = [];
  for (let index = 0; index < head; index += 1) {
    edits.push({ kind: 'equal', oldIndex: index, newIndex: index });
  }
  for (const edit of middle) {
    edits.push({
      kind: edit.kind,
      oldIndex: edit.oldIndex < 0 ? -1 : edit.oldIndex + head,
      newIndex: edit.newIndex < 0 ? -1 : edit.newIndex + head,
    });
  }
  for (let index = 0; index < tail; index += 1) {
    edits.push({
      kind: 'equal',
      oldIndex: before.length - tail + index,
      newIndex: after.length - tail + index,
    });
  }
  return { edits, coarse };
}

/** Words, runs of whitespace, and every other character on its own. */
const TOKEN_PATTERN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

function tokenize(line: string): string[] {
  return line.match(TOKEN_PATTERN) ?? [];
}

function pushSegment(segments: DiffSegment[], text: string, changed: boolean): void {
  const last = segments[segments.length - 1];
  if (last && last.changed === changed) last.text += text;
  else segments.push({ text, changed });
}

/**
 * Compares a removed line with the added line that replaced it, word by word.
 * Returns null when the two have too little in common for the marking to mean
 * anything — then they are simply a removed line and an added line.
 */
export function diffWords(
  removed: string,
  added: string,
): { removed: DiffSegment[]; added: DiffSegment[] } | null {
  if (removed.length > MAX_INLINE_LENGTH || added.length > MAX_INLINE_LENGTH) return null;
  const before = tokenize(removed);
  const after = tokenize(added);
  if (before.length === 0 || after.length === 0) return null;

  const { edits, coarse } = editScript(before, after, 400, 4_000);
  if (coarse) return null;

  let shared = 0;
  const removedSegments: DiffSegment[] = [];
  const addedSegments: DiffSegment[] = [];
  for (const edit of edits) {
    if (edit.kind === 'equal') {
      const token = before[edit.oldIndex]!;
      if (token.trim() !== '') shared += token.length;
      pushSegment(removedSegments, token, false);
      pushSegment(addedSegments, token, false);
    } else if (edit.kind === 'delete') {
      pushSegment(removedSegments, before[edit.oldIndex]!, true);
    } else {
      pushSegment(addedSegments, after[edit.newIndex]!, true);
    }
  }

  const longest = Math.max(removed.replace(/\s+/g, '').length, added.replace(/\s+/g, '').length);
  if (longest === 0 || shared / longest < MIN_INLINE_SIMILARITY) return null;
  return { removed: removedSegments, added: addedSegments };
}

/**
 * Pairs each run of removed lines with the run of added lines that follows it,
 * first with first, and marks the words that changed inside each pair.
 */
function markRewrittenLines(lines: DiffLine[]): void {
  let index = 0;
  while (index < lines.length) {
    if (lines[index]!.kind !== 'removed') {
      index += 1;
      continue;
    }
    const removedStart = index;
    while (index < lines.length && lines[index]!.kind === 'removed') index += 1;
    const addedStart = index;
    while (index < lines.length && lines[index]!.kind === 'added') index += 1;

    const pairs = Math.min(addedStart - removedStart, index - addedStart);
    for (let pair = 0; pair < pairs; pair += 1) {
      const removed = lines[removedStart + pair]!;
      const added = lines[addedStart + pair]!;
      const words = diffWords(removed.text, added.text);
      if (!words) continue;
      removed.segments = words.removed;
      added.segments = words.added;
    }
  }
}

/** Compares two texts line by line and groups the changes into hunks. */
export function diffText(before: string, after: string, options: DiffOptions = {}): TextDiff {
  const context = Math.max(0, Math.floor(options.context ?? DEFAULT_CONTEXT_LINES));
  const empty: TextDiff = {
    identical: true,
    onlyLineEndings: false,
    coarse: false,
    stats: { added: 0, removed: 0 },
    hunks: [],
  };
  if (before === after) return empty;

  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const { edits, coarse } = editScript(oldLines, newLines, MAX_EDIT_DISTANCE, MAX_DIFF_LINES);

  const lines: DiffLine[] = edits.map((edit) => {
    if (edit.kind === 'equal') {
      return {
        kind: 'context',
        text: newLines[edit.newIndex]!,
        oldNumber: edit.oldIndex + 1,
        newNumber: edit.newIndex + 1,
      };
    }
    if (edit.kind === 'delete') {
      return {
        kind: 'removed',
        text: oldLines[edit.oldIndex]!,
        oldNumber: edit.oldIndex + 1,
        newNumber: null,
      };
    }
    return {
      kind: 'added',
      text: newLines[edit.newIndex]!,
      oldNumber: null,
      newNumber: edit.newIndex + 1,
    };
  });

  const stats: DiffStats = { added: 0, removed: 0 };
  for (const line of lines) {
    if (line.kind === 'added') stats.added += 1;
    else if (line.kind === 'removed') stats.removed += 1;
  }
  if (stats.added === 0 && stats.removed === 0) {
    return { ...empty, identical: false, onlyLineEndings: true };
  }

  if (!coarse) markRewrittenLines(lines);

  // A line belongs to a hunk when it is a change or within `context` lines of
  // one; hunks whose context would touch are one hunk.
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === 'context') return;
    const from = Math.max(0, index - context);
    const to = Math.min(lines.length - 1, index + context);
    for (let cursor = from; cursor <= to; cursor += 1) keep[cursor] = true;
  });

  const hunks: DiffHunk[] = [];
  let current: DiffLine[] = [];
  // The last line number passed on each side, for a hunk that has no line of
  // its own on that side: the unified-diff convention is that it starts after
  // the line before it, and at 0 when there is none.
  let oldPassed = 0;
  let newPassed = 0;
  let oldBefore = 0;
  let newBefore = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    hunks.push({
      oldStart: current.find((line) => line.oldNumber !== null)?.oldNumber ?? oldBefore,
      oldLines: current.filter((line) => line.kind !== 'added').length,
      newStart: current.find((line) => line.newNumber !== null)?.newNumber ?? newBefore,
      newLines: current.filter((line) => line.kind !== 'removed').length,
      lines: current,
    });
    current = [];
  };
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (current.length === 0) {
        oldBefore = oldPassed;
        newBefore = newPassed;
      }
      current.push(line);
    } else {
      flush();
    }
    if (line.oldNumber !== null) oldPassed = line.oldNumber;
    if (line.newNumber !== null) newPassed = line.newNumber;
  });
  flush();

  return { identical: false, onlyLineEndings: false, coarse, stats, hunks };
}
