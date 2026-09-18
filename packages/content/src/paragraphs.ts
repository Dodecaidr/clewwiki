import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { Root, RootContent } from 'mdast';

/**
 * The blocks of a page body that a comment can be attached to, and the way a
 * comment finds its block again after the page has changed.
 *
 * A block is a top-level node of the Markdown — a paragraph, a heading, a
 * table, a fence, a quote — except that a list is taken apart into its items,
 * because "the third step is wrong" is about the third step. The body is parsed
 * with the parser the page view renders with, so the blocks are exactly the
 * things a reader sees as separate.
 *
 * **An anchor is a fingerprint of the block's text, not a position.** Positions
 * shift whenever anything above is edited; the text of a paragraph nobody
 * touched does not. So a comment stays attached to its paragraph through any
 * edit elsewhere on the page, and the moment the paragraph itself is rewritten
 * the comment is *outdated* — it is not moved to whatever now sits where the
 * paragraph was, and it is not matched to something merely similar. A comment
 * shown against text it was not written about is worse than one that says
 * plainly that its text has changed.
 *
 * The fingerprint is not a security boundary and is not a content hash: it only
 * has to tell the blocks of one page apart, so it is a small non-cryptographic
 * hash that runs the same in a browser and on the server.
 */

export type ParagraphKind =
  | 'paragraph'
  | 'heading'
  | 'listItem'
  | 'code'
  | 'table'
  | 'blockquote'
  | 'other';

export interface ParagraphBlock {
  /** Zero-based position among the page's blocks. */
  index: number;
  kind: ParagraphKind;
  /** One-based, inclusive. */
  startLine: number;
  endLine: number;
  /** The block's source, whitespace normalised. What the fingerprint is taken of. */
  text: string;
  fingerprint: string;
}

/** Longest excerpt of a block stored with a comment, so it can be shown once the block is gone. */
export const MAX_QUOTE_LENGTH = 280;

const parser = unified().use(remarkParse).use(remarkGfm).freeze();

const KINDS: Record<string, ParagraphKind> = {
  paragraph: 'paragraph',
  heading: 'heading',
  listItem: 'listItem',
  code: 'code',
  table: 'table',
  blockquote: 'blockquote',
};

/** Whitespace is not content: re-wrapping a paragraph must not orphan its comments. */
export function normalizeBlockText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * cyrb53: 53 bits from two 32-bit multiplicative rounds. Plenty to tell a few
 * hundred blocks apart; not for anything an adversary gains from colliding.
 */
export function fingerprintText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return value.toString(16).padStart(14, '0');
}

export function excerptOf(text: string): string {
  const normalized = normalizeBlockText(text);
  return normalized.length <= MAX_QUOTE_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_QUOTE_LENGTH - 1)}…`;
}

/** Splits a page body into the blocks a comment can be attached to. */
export function splitParagraphs(markdown: string): ParagraphBlock[] {
  const tree = parser.parse(markdown) as Root;
  const lines = markdown.split('\n');
  const blocks: ParagraphBlock[] = [];

  const push = (node: RootContent | { type: string; position?: RootContent['position'] }): void => {
    const position = node.position;
    if (!position) return;
    const startLine = position.start.line;
    const endLine = position.end.line;
    const text = normalizeBlockText(lines.slice(startLine - 1, endLine).join('\n'));
    if (text === '') return;
    blocks.push({
      index: blocks.length,
      kind: KINDS[node.type] ?? 'other',
      startLine,
      endLine,
      text,
      fingerprint: fingerprintText(text),
    });
  };

  for (const node of tree.children) {
    // Definitions and the like draw nothing a reader could point at.
    if (node.type === 'definition' || node.type === 'footnoteDefinition') continue;
    if (node.type === 'list') {
      for (const item of node.children) push(item);
    } else {
      push(node);
    }
  }
  return blocks;
}

export interface StoredAnchor {
  fingerprint: string;
  /** Where the block was when the comment was written; breaks ties between identical blocks. */
  index: number;
}

/**
 * Finds the block a comment was written about in the page as it is now, or null
 * when no block has that text any more. Among several identical blocks — two
 * `---` rules, a repeated heading — the one nearest the original position wins.
 */
export function resolveAnchor(
  blocks: readonly ParagraphBlock[],
  anchor: StoredAnchor,
): ParagraphBlock | null {
  let best: ParagraphBlock | null = null;
  for (const block of blocks) {
    if (block.fingerprint !== anchor.fingerprint) continue;
    if (!best || Math.abs(block.index - anchor.index) < Math.abs(best.index - anchor.index)) {
      best = block;
    }
  }
  return best;
}

export type QuoteMatch =
  | { ok: true; block: ParagraphBlock }
  | { ok: false; reason: 'not_found' | 'ambiguous'; candidates: number };

/**
 * Finds the one block containing a quoted passage. This is how a caller that
 * reads bodies rather than rendered pages — an agent — says where its comment
 * goes: it quotes what it is talking about. A quote found in several blocks is
 * refused rather than guessed at; the caller quotes a little more.
 */
export function findBlockByQuote(blocks: readonly ParagraphBlock[], quote: string): QuoteMatch {
  const needle = normalizeBlockText(quote);
  if (needle === '') return { ok: false, reason: 'not_found', candidates: 0 };
  const matches = blocks.filter((block) => block.text.includes(needle));
  if (matches.length === 1) return { ok: true, block: matches[0]! };
  return {
    ok: false,
    reason: matches.length === 0 ? 'not_found' : 'ambiguous',
    candidates: matches.length,
  };
}
