/**
 * Emitting the Markdown this project renders.
 *
 * Every converter ends up here, so the dialect is decided once: GitHub-flavoured
 * Markdown as `remark-gfm` reads it, callouts as GitHub alerts (`> [!NOTE]`),
 * code in fences that carry a language, tables as GFM pipe tables. Nothing
 * emits raw HTML except the one `<details>` a Notion toggle becomes, and that
 * is emitted knowing the renderer drops it — see `detailsBlock`.
 */

import type { CalloutKind } from '@clewwiki/content/callouts';

/** Characters that start a Markdown construct at the beginning of a line. */
const LINE_LEADERS = /^(\s*)([#>\-+*]|\d+[.)]|```|~~~|\|)/;

/** Escapes inline text so a converted string cannot become markup by accident. */
export function escapeInline(value: string): string {
  return value.replace(/([\\`*_[\]<>])/g, '\\$1');
}

/** Escapes a whole line, including a leader that would start a block. */
export function escapeBlockText(value: string): string {
  const escaped = escapeInline(value);
  return LINE_LEADERS.test(escaped) ? escaped.replace(LINE_LEADERS, '$1\\$2') : escaped;
}

/** A link destination, with the characters that would end it percent-encoded. */
export function escapeUrl(value: string): string {
  return value.replace(/[()\s<>]/g, (char) => encodeURIComponent(char));
}

export function link(text: string, href: string): string {
  return `[${escapeInline(text || href)}](${escapeUrl(href)})`;
}

export function image(alt: string, src: string): string {
  return `![${escapeInline(alt)}](${escapeUrl(src)})`;
}

/**
 * A fenced code block.
 *
 * The fence is long enough to survive a body that contains backticks, and the
 * language is reduced to the token a highlighter understands — a Confluence
 * code macro happily stores `Java 8` in that parameter.
 */
export function codeBlock(source: string, language?: string): string {
  const body = source.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const longest = /`{3,}/g.exec(body);
  const fence = '`'.repeat(Math.max(3, (longest?.[0].length ?? 0) + 1));
  return `${fence}${normalizeLanguage(language)}\n${body}\n${fence}`;
}

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  'c#': 'csharp',
  'c++': 'cpp',
  html_xml: 'html',
  js: 'javascript',
  none: 'text',
  plain: 'text',
  ps: 'powershell',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  yml: 'yaml',
};

export function normalizeLanguage(value: string | undefined): string {
  if (!value) return '';
  const token = value.trim().toLowerCase().split(/[\s,]/)[0] ?? '';
  const cleaned = token.replace(/[^a-z0-9+#_-]/g, '');
  if (cleaned === '') return '';
  return LANGUAGE_ALIASES[cleaned] ?? cleaned;
}

/** A GitHub alert — how this project stores every callout. */
export function calloutBlock(kind: CalloutKind, body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').trim().split('\n');
  return [`> [!${kind}]`, ...lines.map((line) => (line === '' ? '>' : `> ${line}`))].join('\n');
}

/**
 * A GFM table. Cells are flattened to one line, because a pipe table has no
 * way to hold a paragraph break and a cell that contains one would otherwise
 * end the table halfway through.
 */
export function tableBlock(header: string[], rows: string[][]): string {
  const width = Math.max(header.length, ...rows.map((row) => row.length), 1);
  const cell = (value: string | undefined): string =>
    (value ?? '').replace(/\r\n?|\n/g, ' ').replace(/\|/g, '\\|').trim();
  const line = (values: string[]): string =>
    `| ${Array.from({ length: width }, (_, index) => cell(values[index])).join(' | ')} |`;
  return [line(header), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.map(line)].join(
    '\n',
  );
}

/**
 * A `<details>` block for a collapsible section.
 *
 * The page renderer drops raw HTML on purpose, so this is only ever used where
 * the caller has decided a heading is the wrong shape and has attached a
 * warning saying the block will render as plain text. Converters that can use a
 * heading use a heading.
 */
export function detailsBlock(summary: string, body: string): string {
  return `<details>\n<summary>${escapeInline(summary)}</summary>\n\n${body.trim()}\n\n</details>`;
}

export function heading(level: number, text: string): string {
  const depth = Math.min(Math.max(Math.round(level), 1), 6);
  return `${'#'.repeat(depth)} ${text.replace(/\r\n?|\n/g, ' ').trim()}`;
}

/** Joins blocks with exactly one blank line and no leading or trailing space. */
export function joinBlocks(blocks: readonly string[]): string {
  return blocks
    .map((block) => block.replace(/[ \t]+$/gm, '').trim())
    .filter((block) => block !== '')
    .join('\n\n');
}

/**
 * Normalises a finished body: CRLF gone, no run of more than one blank line,
 * one trailing newline. Every adapter's last step, so a page created by an
 * import looks the same whichever source it came from.
 */
export function finishBody(markdown: string): string {
  const normalized = markdown
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return normalized === '' ? '' : `${normalized}\n`;
}
