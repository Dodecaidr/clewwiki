import { describe, expect, it } from 'vitest';

import {
  MAX_QUOTE_LENGTH,
  excerptOf,
  findBlockByQuote,
  fingerprintText,
  resolveAnchor,
  splitParagraphs,
} from '../src/paragraphs';

const BODY = [
  '# Authentication',
  '',
  'Agent tokens are hashed',
  'before they are stored.',
  '',
  '1. Create a token.',
  '2. Put it in the environment.',
  '   Never in a config file.',
  '',
  '```sh',
  'export CLEWWIKI_TOKEN=...',
  '```',
  '',
  '| Scope | Meaning |',
  '| --- | --- |',
  '| `pages:read` | Read |',
  '',
  '> Tokens are shown once.',
  '',
  '[docs]: https://example.com',
  '',
].join('\n');

describe('splitParagraphs', () => {
  it('makes a block of every top-level node, and of every list item', () => {
    const blocks = splitParagraphs(BODY);
    expect(blocks.map((block) => [block.index, block.kind, block.startLine, block.endLine])).toEqual([
      [0, 'heading', 1, 1],
      [1, 'paragraph', 3, 4],
      [2, 'listItem', 6, 6],
      [3, 'listItem', 7, 8],
      [4, 'code', 10, 12],
      [5, 'table', 14, 16],
      [6, 'blockquote', 18, 18],
    ]);
    expect(blocks[1]!.text).toBe('Agent tokens are hashed before they are stored.');
  });

  it('has nothing to say about an empty body', () => {
    expect(splitParagraphs('')).toEqual([]);
    expect(splitParagraphs('\n\n  \n')).toEqual([]);
  });
});

describe('anchors', () => {
  it('follow a paragraph through edits elsewhere on the page', () => {
    const before = splitParagraphs(BODY);
    const target = before[3]!;
    const after = splitParagraphs(`Intro added on top.\n\nAnd another line.\n\n${BODY}`);
    const found = resolveAnchor(after, { fingerprint: target.fingerprint, index: target.index });
    expect(found).not.toBeNull();
    expect(found!.index).toBe(5);
    expect(found!.text).toBe(target.text);
  });

  it('survive re-wrapping, which changes whitespace and nothing else', () => {
    const target = splitParagraphs(BODY)[1]!;
    const rewrapped = splitParagraphs(BODY.replace('hashed\nbefore', 'hashed before'));
    expect(resolveAnchor(rewrapped, target)?.index).toBe(1);
  });

  it('are lost, not moved, when the paragraph itself is rewritten', () => {
    const target = splitParagraphs(BODY)[1]!;
    const edited = splitParagraphs(BODY.replace('are hashed', 'are salted and hashed'));
    expect(resolveAnchor(edited, target)).toBeNull();
    // The block now in that position is a different text and is not offered.
    expect(edited[1]!.fingerprint).not.toBe(target.fingerprint);
  });

  it('pick the nearest of several identical blocks', () => {
    const blocks = splitParagraphs('Same.\n\nOther.\n\nSame.\n\nMore.\n\nSame.\n');
    const same = blocks.filter((block) => block.text === 'Same.');
    expect(same.map((block) => block.index)).toEqual([0, 2, 4]);
    expect(resolveAnchor(blocks, { fingerprint: same[0]!.fingerprint, index: 4 })?.index).toBe(4);
    expect(resolveAnchor(blocks, { fingerprint: same[0]!.fingerprint, index: 1 })?.index).toBe(0);
    expect(resolveAnchor(blocks, { fingerprint: same[0]!.fingerprint, index: 3 })?.index).toBe(2);
  });
});

describe('findBlockByQuote', () => {
  const blocks = splitParagraphs(BODY);

  it('finds the one block containing the quoted words, whatever their wrapping', () => {
    const match = findBlockByQuote(blocks, 'hashed   before they');
    expect(match).toMatchObject({ ok: true, block: { index: 1 } });
    expect(findBlockByQuote(blocks, 'Never in a config file')).toMatchObject({
      ok: true,
      block: { index: 3 },
    });
  });

  it('refuses a quote that is nowhere, or in more than one place', () => {
    expect(findBlockByQuote(blocks, 'rotated monthly')).toEqual({
      ok: false,
      reason: 'not_found',
      candidates: 0,
    });
    expect(findBlockByQuote(blocks, 'oken')).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(findBlockByQuote(blocks, '   ')).toMatchObject({ ok: false, reason: 'not_found' });
  });
});

describe('fingerprints and excerpts', () => {
  it('are stable, fixed-width and sensitive to a single character', () => {
    expect(fingerprintText('abc')).toBe(fingerprintText('abc'));
    expect(fingerprintText('abc')).not.toBe(fingerprintText('abd'));
    expect(fingerprintText('Токены хранятся в виде хеша.')).toMatch(/^[0-9a-f]{14}$/);
    expect(fingerprintText('')).toMatch(/^[0-9a-f]{14}$/);
  });

  it('cut a long block to the quote limit', () => {
    expect(excerptOf('short  text')).toBe('short text');
    const long = excerptOf('word '.repeat(200));
    expect(long.length).toBe(MAX_QUOTE_LENGTH);
    expect(long.endsWith('…')).toBe(true);
  });
});
