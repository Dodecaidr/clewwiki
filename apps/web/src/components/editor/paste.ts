/**
 * Clipboard handling for the visual editor.
 *
 * HTML pasted from a word processor, Google Docs or Confluence is parsed by
 * the editor's own schema, which is what turns it into Markdown-shaped blocks:
 * a heading stays a heading, a table stays a table, bold and italic stay
 * marks, and everything the schema has no place for — fonts, sizes, colours,
 * classes, inline styles — is simply not carried over. This module only clears
 * the debris those applications put around the content before that happens.
 */

/**
 * Removes clipboard markup that is never content: style sheets, metadata,
 * Word's conditional comments and `o:` namespace tags, and the wrapper Google
 * Docs puts around a whole selection.
 */
export function cleanPastedHtml(html: string): string {
  return (
    html
      // Style sheets and scripts: their text would otherwise be pasted as prose.
      .replace(/<(style|script|xml|title)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<meta\b[^>]*>/gi, '')
      .replace(/<link\b[^>]*>/gi, '')
      // Word's conditional comments and ordinary comments.
      .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      // Word's Office namespace elements (<o:p>, <w:…>) carry no text of their own.
      .replace(/<\/?(o|w|v|m):[^>]*>/gi, '')
  );
}

/**
 * Plain text that is worth reading as Markdown rather than as lines of prose:
 * it has a heading, a list, a table, a fence or a quote at the start of a line.
 * Pasting an agent's answer should give the answer's structure, not its
 * punctuation.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (text.length > 1_000_000) return false;
  const patterns = [
    /^#{1,6}\s+\S/m,
    /^\s*[-*+]\s+(\[[ xX]\]\s+)?\S/m,
    /^\s*\d+[.)]\s+\S/m,
    /^\s*\|.*\|\s*$/m,
    /^\s*(```|~~~)/m,
    /^\s*>\s?/m,
    /\*\*[^*\n]+\*\*/,
    /\[[^\]\n]+\]\([^)\s]+\)/,
  ];
  const hits = patterns.filter((pattern) => pattern.test(text)).length;
  return hits >= 1 && text.includes('\n') ? true : hits >= 2;
}
