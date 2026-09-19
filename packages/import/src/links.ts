/**
 * Intra-document links.
 *
 * A converter cannot know where a page will land: the tree is not placed until
 * every node has been read, and a reviewer may move a page again before the
 * import is applied. So a link that points at another page of the same import
 * is written as a placeholder — `clewwiki-import:<source id>` — and resolved
 * afterwards, as many times as it needs to be.
 *
 * It is resolved twice in practice. The preview resolves placeholders to target
 * paths, which is what a reviewer is deciding about; applying the import
 * resolves them to the created pages' addresses, which is what a reader needs.
 * Both go through `rewriteLinks`, so a link cannot be correct in one and wrong
 * in the other.
 *
 * A placeholder nobody claims — the page it pointed at was skipped, or was
 * never in the export — becomes plain text, with the original title kept, and
 * the item carries an `unresolved-link` warning. A dangling link that silently
 * 404s is worse than a sentence that reads.
 */

import { encodeDestination } from './images';
import { escapeInline } from './markdown-out';
import { warn } from './types';
import type { ImportWarning } from './types';

export const LINK_SCHEME = 'clewwiki-import:';

/** The placeholder a converter writes for a link to another imported page. */
export function placeholderFor(sourceId: string, fragment?: string): string {
  const anchor = fragment ? `#${encodeDestination(fragment)}` : '';
  return `${LINK_SCHEME}${encodeDestination(sourceId)}${anchor}`;
}

/** True when a body still has at least one unresolved placeholder. */
export function hasPlaceholders(markdown: string): boolean {
  return markdown.includes(LINK_SCHEME);
}

/**
 * Matches the destination of an inline link or image. The destination of a
 * placeholder never contains a space, a bracket or a parenthesis, because
 * `placeholderFor` percent-encodes the source id, so the pattern can stay this
 * simple.
 */
const PLACEHOLDER = /(!?)\[([^\]]*)\]\(clewwiki-import:([^)\s#]*)(#[^)\s]*)?\)/g;

export interface RewriteResult {
  markdown: string;
  warnings: ImportWarning[];
}

/**
 * Replaces every placeholder with what `resolve` returns for its source id, or
 * flattens it to text when `resolve` returns null.
 */
export function rewriteLinks(
  markdown: string,
  resolve: (sourceId: string) => string | null,
): RewriteResult {
  const warnings: ImportWarning[] = [];
  const seen = new Set<string>();

  const rewritten = markdown.replace(
    PLACEHOLDER,
    (_match, bang: string, text: string, encodedId: string, fragment: string | undefined) => {
      const sourceId = safeDecode(encodedId);
      const target = resolve(sourceId);
      if (target === null) {
        if (!seen.has(sourceId)) {
          seen.add(sourceId);
          warnings.push(warn('unresolved-link', sourceId));
        }
        // An image whose page is gone leaves its alt text; a link leaves its
        // label. Both stay readable, neither pretends to still be a link.
        return text === '' ? '' : escapeInline(text);
      }
      const anchor = fragment ? `#${slugifyFragment(safeDecode(fragment.slice(1)))}` : '';
      return `${bang}[${text}](${target}${anchor})`;
    },
  );

  return { markdown: rewritten, warnings };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * A heading anchor in the form the renderer produces: lowercase, spaces to
 * hyphens, punctuation dropped. A Confluence or Notion fragment names the
 * heading text, so this is the same transformation the reader's browser will
 * be looking for.
 */
export function slugifyFragment(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}
