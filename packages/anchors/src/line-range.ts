import { hashTokenList } from './tokens';

/**
 * The fallback for blocks with no resolvable declaration — a configuration
 * stanza, a prose section, a table of constants.
 *
 * It is deliberately weaker than a declaration anchor and deliberately kept
 * separate from one. A line range does not survive an edit above it, so every
 * anchor that lands here is a future false "stale"; the share of anchors on
 * this path is reported per workspace precisely so that a repository where it
 * climbs can be noticed before the badge stops being believed.
 */

export interface LineRangeAnchor {
  lineStart: number;
  lineEnd: number;
  /** Hash of the normalised lines, stored in the same column as a token hash. */
  hash: string;
  lineCount: number;
}

/**
 * Normalisation, such as it can be without a parser: every line is trimmed and
 * blank lines are dropped. Re-indenting a block therefore does not flag it,
 * which is the cheapest formatting change to absorb and the most common.
 */
function normalizeLines(lines: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed !== '') normalized.push(trimmed);
  }
  return normalized;
}

/**
 * Hashes lines `start..end` of `source`, 1-based and inclusive.
 *
 * Returns null when the range does not exist in this revision of the file —
 * a file that lost those lines cannot answer "did they change", and the
 * resolver reports that as `lost` rather than guessing.
 */
export function lineRangeAnchor(
  source: string,
  start: number,
  end: number,
): LineRangeAnchor | null {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 1 || end < start) return null;

  const lines = source.split('\n');
  if (end > lines.length) return null;

  const slice = normalizeLines(lines.slice(start - 1, end));
  return {
    lineStart: start,
    lineEnd: end,
    hash: hashTokenList(slice),
    lineCount: slice.length,
  };
}
