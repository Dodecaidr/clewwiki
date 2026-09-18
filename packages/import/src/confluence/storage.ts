/**
 * Confluence storage format to Markdown.
 *
 * The rule the whole converter is built on: nothing is dropped silently. A
 * macro with a Markdown equivalent becomes that equivalent; a macro without one
 * becomes a visible `> [!NOTE]` naming it, and the page carries a warning
 * saying so. A reviewer reading the preview can therefore see every place the
 * import had to make a decision, which is the only way a migration of somebody's
 * documentation can be trusted.
 *
 * What converts: headings, paragraphs, emphasis, inline code, lists (nested,
 * including task lists), tables, blockquotes, horizontal rules, links —
 * internal ones through the placeholder in `../links` — images, the `code` and
 * `noformat` macros, the `info`/`note`/`tip`/`warning`/`panel` panels, `expand`,
 * `status`, `toc` and the layout elements Confluence Cloud wraps a page in.
 *
 * What does not: everything else, which is a long tail of macros that render
 * dynamic content — Jira issue lists, page trees, includes, charts. They could
 * not be carried across even in principle, because the data behind them stays
 * in Confluence.
 */

import type { CalloutKind } from '@clewwiki/content/callouts';

import {
  calloutBlock,
  codeBlock,
  escapeBlockText,
  escapeInline,
  finishBody,
  heading,
  image,
  joinBlocks,
  link,
  tableBlock,
} from '../markdown-out';
import { placeholderFor } from '../links';
import { warn } from '../types';
import type { ImportWarning } from '../types';
import { childrenNamed, findElement, parseXml, textOf } from './xml';
import type { XmlElement, XmlNode } from './xml';

export interface StorageContext {
  /**
   * Absolute base of the Confluence site, used to turn an attachment into a URL
   * a reader can still open. Without it, attachments become warnings alone.
   */
  baseUrl?: string;
  /** The page being converted, so an attachment URL can name it. */
  pageId?: string;
  /** Page title to id, for resolving `ri:page` links inside the same space. */
  pageIdByTitle?: ReadonlyMap<string, string>;
}

export interface StorageResult {
  markdown: string;
  warnings: ImportWarning[];
  /** Attachment file names the page referenced. */
  attachments: string[];
}

/** Panel macros and the alert each becomes. */
const PANEL_KINDS: Readonly<Record<string, CalloutKind>> = {
  info: 'NOTE',
  note: 'IMPORTANT',
  tip: 'TIP',
  warning: 'WARNING',
  panel: 'NOTE',
};

const HEADINGS: Readonly<Record<string, number>> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/** Wrappers that contribute nothing but their contents. */
const TRANSPARENT = new Set([
  '#root',
  'ac:layout',
  'ac:layout-section',
  'ac:layout-cell',
  'ac:rich-text-body',
  'ac:task-body',
  'div',
  'span',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'figure',
  'tbody',
  'thead',
  'tfoot',
  'colgroup',
  'font',
  'small',
  'time',
  'label',
]);

export function convertStorageToMarkdown(
  storage: string,
  context: StorageContext = {},
): StorageResult {
  const state = new ConversionState(context);
  const blocks = state.blocks(parseXml(storage).children);
  return {
    markdown: finishBody(joinBlocks(blocks)),
    warnings: state.warnings,
    attachments: [...state.attachments],
  };
}

class ConversionState {
  readonly warnings: ImportWarning[] = [];
  readonly attachments = new Set<string>();
  private readonly reported = new Set<string>();

  constructor(private readonly context: StorageContext) {}

  private note(code: ImportWarning['code'], detail?: string): void {
    const key = `${code}:${detail ?? ''}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.warnings.push(warn(code, detail));
  }

  /* ---------------------------------------------------------------- */
  /* Blocks                                                            */
  /* ---------------------------------------------------------------- */

  blocks(nodes: readonly XmlNode[]): string[] {
    const out: string[] = [];
    let inline: string[] = [];

    const flush = (): void => {
      const text = collapse(inline.join(''));
      if (text !== '') out.push(text);
      inline = [];
    };

    for (const node of nodes) {
      if (node.type === 'text') {
        inline.push(escapeBlockText(node.value));
        continue;
      }
      const block = this.block(node);
      if (block === null) {
        inline.push(this.inline(node));
        continue;
      }
      flush();
      if (block !== '') out.push(block);
    }
    flush();
    return out;
  }

  /** The block form of an element, or null when it belongs in a paragraph. */
  private block(node: XmlElement): string | null {
    const level = HEADINGS[node.name];
    if (level !== undefined) {
      const text = collapse(this.inlineChildren(node));
      return text === '' ? '' : heading(level, text);
    }

    switch (node.name) {
      case 'p':
        return collapse(this.inlineChildren(node));
      case 'br':
        return null;
      case 'hr':
        return '---';
      case 'ul':
      case 'ol':
      case 'ac:task-list':
        return this.list(node, 0);
      case 'blockquote':
        return quote(joinBlocks(this.blocks(node.children)));
      case 'pre':
        return codeBlock(textOf(node));
      case 'table':
        return this.table(node);
      case 'ac:structured-macro':
        return this.macro(node);
      case 'ac:image':
        return this.image(node);
      default:
        break;
    }

    if (TRANSPARENT.has(node.name)) {
      const inner = this.blocks(node.children);
      return inner.length === 0 ? '' : joinBlocks(inner);
    }
    return null;
  }

  private list(node: XmlElement, depth: number): string {
    const ordered = node.name === 'ol';
    const tasks = node.name === 'ac:task-list';
    const items = tasks ? childrenNamed(node, 'ac:task') : childrenNamed(node, 'li');
    const lines: string[] = [];
    let number = 0;

    for (const item of items) {
      number += 1;
      const marker = tasks
        ? `- [${textOf(findElement(item, 'ac:task-status') ?? item).trim() === 'complete' ? 'x' : ' '}] `
        : ordered
          ? `${number}. `
          : '- ';
      const nested: string[] = [];
      const own: XmlNode[] = [];
      // A task carries its id and its status alongside its body; only the body
      // is content.
      const source = tasks ? (findElement(item, 'ac:task-body')?.children ?? []) : item.children;
      for (const child of source) {
        if (child.type === 'element' && (child.name === 'ul' || child.name === 'ol')) {
          nested.push(this.list(child, depth + 1));
        } else {
          own.push(child);
        }
      }
      const body = joinBlocks(this.blocks(own));
      const indent = ' '.repeat(depth * 2);
      const continuation = indent + ' '.repeat(marker.length);
      const rendered = body === '' ? '' : body.split('\n').map((line, index) => (index === 0 ? line : continuation + line)).join('\n');
      lines.push(`${indent}${marker}${rendered}`.replace(/\s+$/, ''));
      for (const block of nested) lines.push(block);
    }
    return lines.join('\n');
  }

  private table(node: XmlElement): string {
    const rows: XmlElement[] = [];
    const collect = (element: XmlElement): void => {
      for (const child of element.children) {
        if (child.type !== 'element') continue;
        if (child.name === 'tr') rows.push(child);
        else collect(child);
      }
    };
    collect(node);
    if (rows.length === 0) return '';

    const cells = rows.map((row) =>
      row.children
        .filter((child): child is XmlElement => child.type === 'element' && (child.name === 'th' || child.name === 'td'))
        .map((cell) => collapse(this.inlineChildren(cell))),
    );

    const first = cells[0] ?? [];
    const firstIsHeader = (rows[0]?.children ?? []).some(
      (child) => child.type === 'element' && child.name === 'th',
    );
    // A table with no header row still has to have one in GFM; an empty header
    // reads better than promoting a row of data into a heading.
    const header = firstIsHeader ? first : first.map(() => '');
    const body = firstIsHeader ? cells.slice(1) : cells;
    return tableBlock(header, body);
  }

  /* ---------------------------------------------------------------- */
  /* Macros                                                            */
  /* ---------------------------------------------------------------- */

  private parameters(node: XmlElement): Map<string, string> {
    const out = new Map<string, string>();
    for (const parameter of childrenNamed(node, 'ac:parameter')) {
      const name = parameter.attrs['ac:name'] ?? '';
      out.set(name, textOf(parameter).trim());
    }
    return out;
  }

  private macro(node: XmlElement): string {
    const name = (node.attrs['ac:name'] ?? '').toLowerCase();
    const parameters = this.parameters(node);
    const richBody = findElement(node, 'ac:rich-text-body');
    const plainBody = findElement(node, 'ac:plain-text-body');

    if (name === 'code') {
      return codeBlock(textOf(plainBody ?? node), parameters.get('language'));
    }
    if (name === 'noformat') {
      return codeBlock(textOf(plainBody ?? node), 'text');
    }
    const panel = PANEL_KINDS[name];
    if (panel !== undefined) {
      const title = parameters.get('title');
      const body = richBody ? joinBlocks(this.blocks(richBody.children)) : textOf(node).trim();
      return calloutBlock(panel, title ? `**${escapeInline(title)}**\n\n${body}` : body);
    }
    if (name === 'expand') {
      // A heading plus the body, rather than `<details>`: page bodies render
      // Markdown and drop raw HTML, so a real element here would vanish.
      const title = parameters.get('title') ?? 'Details';
      const body = richBody ? joinBlocks(this.blocks(richBody.children)) : '';
      return joinBlocks([`**${escapeInline(title)}**`, body]);
    }
    if (name === 'status') {
      return `\`${(parameters.get('title') ?? '').trim() || 'status'}\``;
    }
    if (name === 'toc') {
      // The table of contents is generated from the headings that are already
      // in the body, so the macro has nothing to carry across.
      return '';
    }
    if (name === 'anchor') {
      return '';
    }

    this.note('unsupported-macro', name || 'unnamed');
    const body = richBody ? joinBlocks(this.blocks(richBody.children)) : '';
    const detail = `Unsupported Confluence macro \`${name || 'unnamed'}\`. It rendered dynamic content that could not be imported; the original page still has it.`;
    return calloutBlock('NOTE', body === '' ? detail : `${detail}\n\n${body}`);
  }

  /* ---------------------------------------------------------------- */
  /* Images, links, inline text                                        */
  /* ---------------------------------------------------------------- */

  private image(node: XmlElement): string {
    const alt = node.attrs['ac:alt'] ?? node.attrs['ac:title'] ?? '';
    const url = findElement(node, 'ri:url');
    if (url) {
      const href = url.attrs['ri:value'] ?? '';
      return href === '' ? '' : image(alt, href);
    }
    const attachment = findElement(node, 'ri:attachment');
    if (!attachment) return '';

    const filename = attachment.attrs['ri:filename'] ?? '';
    if (filename !== '') this.attachments.add(filename);

    // Uploads are out of scope, so the image keeps pointing at Confluence.
    // That is a dependency on the old system, and the warning says so.
    const absolute = this.attachmentUrl(filename);
    this.note('external-attachment', filename || 'attachment');
    return absolute === null ? `_${escapeInline(alt || filename || 'image')}_` : image(alt || filename, absolute);
  }

  private attachmentUrl(filename: string): string | null {
    const { baseUrl, pageId } = this.context;
    if (!baseUrl || !pageId || filename === '') return null;
    return `${baseUrl.replace(/\/+$/, '')}/download/attachments/${encodeURIComponent(pageId)}/${encodeURIComponent(filename)}`;
  }

  private inlineChildren(node: XmlElement): string {
    return node.children.map((child) => this.inline(child)).join('');
  }

  private inline(node: XmlNode): string {
    if (node.type === 'text') return escapeInline(node.value);

    switch (node.name) {
      case 'strong':
      case 'b': {
        const text = this.inlineChildren(node).trim();
        return text === '' ? '' : `**${text}**`;
      }
      case 'em':
      case 'i': {
        const text = this.inlineChildren(node).trim();
        return text === '' ? '' : `*${text}*`;
      }
      case 'del':
      case 's':
      case 'strike': {
        const text = this.inlineChildren(node).trim();
        return text === '' ? '' : `~~${text}~~`;
      }
      case 'code':
      case 'tt':
      case 'kbd': {
        const text = textOf(node);
        return text === '' ? '' : `\`${text.replace(/`/g, 'ˋ')}\``;
      }
      case 'br':
        return '  \n';
      case 'img': {
        const src = node.attrs['src'] ?? '';
        return src === '' ? '' : image(node.attrs['alt'] ?? '', src);
      }
      case 'a': {
        const href = node.attrs['href'] ?? '';
        const text = collapse(this.inlineChildren(node)) || href;
        return href === '' ? text : link(unescapeLabel(text), href);
      }
      case 'ac:link':
        return this.confluenceLink(node);
      case 'ac:image':
        return this.image(node);
      case 'ac:emoticon':
        return escapeInline(node.attrs['ac:emoji-fallback'] ?? node.attrs['ac:name'] ?? '');
      case 'ac:structured-macro':
        return this.macro(node);
      case 'ac:placeholder':
        return '';
      case 'script':
      case 'style':
        // Not content. It never renders, and it must not reach a page body.
        this.note('html-dropped', node.name);
        return '';
      default:
        return this.inlineChildren(node);
    }
  }

  /**
   * `ac:link` is Confluence's own link element: to a page, to an attachment, to
   * a user. A page in the same import becomes a placeholder the rewriter
   * resolves once every target path is known.
   */
  private confluenceLink(node: XmlElement): string {
    const bodyElement = findElement(node, 'ac:link-body') ?? findElement(node, 'ac:plain-text-link-body');
    const label = bodyElement ? collapse(this.inlineChildren(bodyElement)) : '';
    const anchor = node.attrs['ac:anchor'];

    const page = findElement(node, 'ri:page');
    if (page) {
      const title = page.attrs['ri:content-title'] ?? '';
      const id = this.context.pageIdByTitle?.get(title);
      const text = label || title;
      if (id !== undefined) {
        return `[${escapeInline(unescapeLabel(text))}](${placeholderFor(id, anchor)})`;
      }
      // A page in another space, or one the export did not cover.
      this.note('unresolved-link', title || 'page');
      return escapeInline(unescapeLabel(text));
    }

    const attachment = findElement(node, 'ri:attachment');
    if (attachment) {
      const filename = attachment.attrs['ri:filename'] ?? '';
      if (filename !== '') this.attachments.add(filename);
      this.note('external-attachment', filename || 'attachment');
      const absolute = this.attachmentUrl(filename);
      const text = label || filename;
      return absolute === null ? escapeInline(unescapeLabel(text)) : link(unescapeLabel(text), absolute);
    }

    const user = findElement(node, 'ri:user');
    if (user) {
      return escapeInline(label || '@user');
    }

    if (anchor !== undefined) {
      return `[${escapeInline(unescapeLabel(label || anchor))}](#${anchor.toLowerCase().replace(/[^a-z0-9]+/g, '-')})`;
    }
    return escapeInline(unescapeLabel(label));
  }
}

/** A blockquote, one `>` per line. */
function quote(body: string): string {
  const lines = body.trim().split('\n');
  return lines.map((line) => (line === '' ? '>' : `> ${line}`)).join('\n');
}

/**
 * Collapses the whitespace XHTML indentation leaves behind.
 *
 * A hard line break is the one run of whitespace that means something —
 * `<br/>` became `'  \n'` — so it is set aside before the rest is flattened and
 * put back afterwards.
 */
const HARD_BREAK = ' hb ';

function collapse(value: string): string {
  return value
    .replaceAll('  \n', HARD_BREAK)
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .split(HARD_BREAK)
    .map((part) => part.trim())
    .join('  \n')
    .trim();
}

/** Undoes inline escaping for text that is about to be escaped again as a label. */
function unescapeLabel(value: string): string {
  return value.replace(/\\([\\`*_[\]<>])/g, '$1');
}
