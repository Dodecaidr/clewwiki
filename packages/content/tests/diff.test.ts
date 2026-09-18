import { describe, expect, it } from 'vitest';

import { MAX_EDIT_DISTANCE, diffText, diffWords, splitLines } from '../src/diff';
import type { TextDiff } from '../src/diff';

/** Rebuilds both texts from a diff made with unlimited context. */
function replay(diff: TextDiff): { before: string[]; after: string[] } {
  const before: string[] = [];
  const after: string[] = [];
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== 'added') before.push(line.text);
      if (line.kind !== 'removed') after.push(line.text);
    }
  }
  return { before, after };
}

function lines(count: number, label: string): string {
  return Array.from({ length: count }, (_, index) => `${label} ${index + 1}`).join('\n');
}

describe('splitLines', () => {
  it('treats a final line break as the end of the last line', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a')).toEqual(['a']);
    expect(splitLines('a\n')).toEqual(['a']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
  });
});

describe('diffText', () => {
  it('reports identical texts as identical, with nothing to show', () => {
    const diff = diffText('# Title\n\nBody\n', '# Title\n\nBody\n');
    expect(diff).toMatchObject({ identical: true, onlyLineEndings: false, hunks: [] });
    expect(diff.stats).toEqual({ added: 0, removed: 0 });
  });

  it('says so when only the line endings differ', () => {
    for (const [before, after] of [
      ['a\nb', 'a\nb\n'],
      ['a\r\nb\r\n', 'a\nb\n'],
    ] as const) {
      const diff = diffText(before, after);
      expect(diff.identical).toBe(false);
      expect(diff.onlyLineEndings).toBe(true);
      expect(diff.hunks).toEqual([]);
    }
  });

  it('numbers added, removed and unchanged lines on both sides', () => {
    const diff = diffText('one\ntwo\nthree\n', 'one\n2\nthree\nfour\n');
    expect(diff.stats).toEqual({ added: 2, removed: 1 });
    expect(diff.hunks).toHaveLength(1);
    expect(
      diff.hunks[0]!.lines.map((line) => [line.kind, line.text, line.oldNumber, line.newNumber]),
    ).toEqual([
      ['context', 'one', 1, 1],
      ['removed', 'two', 2, null],
      ['added', '2', null, 2],
      ['context', 'three', 3, 3],
      ['added', 'four', null, 4],
    ]);
    expect(diff.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 });
  });

  it('keeps the requested context and splits distant changes into hunks', () => {
    const before = lines(40, 'line');
    const after = before.replace('line 5\n', 'line five\n').replace('line 30\n', 'line thirty\n');
    const diff = diffText(before, after);
    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks[0]).toMatchObject({ oldStart: 2, oldLines: 7, newStart: 2, newLines: 7 });
    expect(diff.hunks[1]).toMatchObject({ oldStart: 27, oldLines: 7, newStart: 27, newLines: 7 });

    const tight = diffText(before, after, { context: 0 });
    expect(tight.hunks.map((hunk) => hunk.lines.length)).toEqual([2, 2]);
  });

  it('merges hunks whose context would overlap', () => {
    const before = lines(20, 'line');
    const after = before.replace('line 5\n', 'x\n').replace('line 9\n', 'y\n');
    expect(diffText(before, after).hunks).toHaveLength(1);
  });

  it('starts a one-sided hunk after the line before it', () => {
    expect(diffText('', 'a\nb\n').hunks[0]).toMatchObject({
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 2,
    });
    expect(diffText('a\nb\nc\n', 'a\nc\n', { context: 0 }).hunks[0]).toMatchObject({
      oldStart: 2,
      oldLines: 1,
      newStart: 1,
      newLines: 0,
    });
  });

  it('replays to both texts whatever was changed', () => {
    const before = ['# Auth', '', 'Tokens are hashed.', '', '## Scopes', '- read', '- write', ''];
    const variants = [
      [...before.slice(0, 2), 'Tokens are hashed with SHA-256.', ...before.slice(3)],
      [...before, '## Expiry', 'Thirty days.'],
      before.slice(4),
      [],
      ['completely', 'different'],
      [...before].reverse(),
    ];
    for (const variant of variants) {
      const diff = diffText(before.join('\n'), variant.join('\n'), { context: 1_000 });
      if (diff.identical) continue;
      const replayed = replay(diff);
      expect(replayed.before).toEqual(splitLines(before.join('\n')));
      expect(replayed.after).toEqual(splitLines(variant.join('\n')));
    }
  });

  it('finds the minimal script rather than any script', () => {
    // The classic example from Myers' paper: ABCABBA -> CBABAC is five edits.
    const diff = diffText('A\nB\nC\nA\nB\nB\nA', 'C\nB\nA\nB\nA\nC');
    expect(diff.stats.added + diff.stats.removed).toBe(5);
  });

  it('falls back to a coarse diff past the edit-distance bound, and says so', () => {
    const before = `head\n${lines(MAX_EDIT_DISTANCE + 50, 'old')}\ntail`;
    const after = `head\n${lines(MAX_EDIT_DISTANCE + 50, 'new')}\ntail`;
    const diff = diffText(before, after, { context: 1 });
    expect(diff.coarse).toBe(true);
    expect(diff.stats).toEqual({ added: MAX_EDIT_DISTANCE + 50, removed: MAX_EDIT_DISTANCE + 50 });
    const texts = diff.hunks[0]!.lines.map((line) => line.text);
    expect(texts[0]).toBe('head');
    expect(texts[texts.length - 1]).toBe('tail');
    expect(diff.hunks[0]!.lines.every((line) => line.segments === undefined)).toBe(true);
  });

  it('is not coarse for a pure insertion or a pure removal, however large', () => {
    const big = lines(MAX_EDIT_DISTANCE * 2, 'row');
    expect(diffText('', big).coarse).toBe(false);
    expect(diffText(big, '').coarse).toBe(false);
  });
});

describe('diffWords', () => {
  it('marks the words that changed inside a rewritten line', () => {
    const diff = diffText('Tokens are hashed with MD5.\n', 'Tokens are hashed with SHA-256.\n');
    const [removed, added] = diff.hunks[0]!.lines;
    expect(removed!.segments).toEqual([
      { text: 'Tokens are hashed with ', changed: false },
      { text: 'MD5', changed: true },
      { text: '.', changed: false },
    ]);
    expect(added!.segments).toEqual([
      { text: 'Tokens are hashed with ', changed: false },
      { text: 'SHA-256', changed: true },
      { text: '.', changed: false },
    ]);
  });

  it('keeps every character of both lines, Cyrillic included', () => {
    const removed = 'Токены хранятся в открытом виде.';
    const added = 'Токены хранятся в виде хеша.';
    const words = diffWords(removed, added);
    expect(words).not.toBeNull();
    expect(words!.removed.map((segment) => segment.text).join('')).toBe(removed);
    expect(words!.added.map((segment) => segment.text).join('')).toBe(added);
    expect(words!.added.some((segment) => segment.changed && segment.text.includes('хеша'))).toBe(true);
  });

  it('gives up when the two lines have little in common', () => {
    expect(diffWords('The quick brown fox.', '## Deployment')).toBeNull();
    expect(diffWords('', 'text')).toBeNull();
    expect(diffWords('x'.repeat(3_000), `${'x'.repeat(3_000)}y`)).toBeNull();
  });
});
