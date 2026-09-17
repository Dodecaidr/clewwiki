import { calloutKindOf, CALLOUT_MARKER } from '@clewwiki/content/callouts';
import type { CalloutKind } from '@clewwiki/content/callouts';
import { CHART_LANGUAGE } from '@clewwiki/content/chart';
import { MERMAID_LANGUAGE } from '@clewwiki/content/mermaid';
import type { JSONContent } from '@tiptap/core';
import type {
  AlignType,
  BlockContent,
  Code,
  DefinitionContent,
  List,
  ListItem,
  Nodes,
  Paragraph,
  Parent,
  Parents,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableCell,
  TableRow,
} from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import type { Options as StringifyOptions } from 'remark-stringify';
import { unified } from 'unified';

import { MARK_ORDER } from './schema';

/**
 * Markdown ⇄ editor document.
 *
 * Markdown is the only thing clewwiki stores, and a page written by an agent
 * has a style of its own — `*` or `-` bullets, `|---|` or `| :--- |` table
 * rules, a trailing newline or none. Opening that page in the visual editor
 * and saving it without an edit must hand back the same bytes, or every visit
 * by a person would show up as a rewrite in the page's history.
 *
 * Two things make that hold:
 *
 * 1. **The parser is the renderer's parser.** Markdown is read with
 *    `remark-parse` and the GitHub extensions — exactly what the page view
 *    and the server-side validation use — so the editor cannot see a
 *    different document than a reader does.
 * 2. **Untouched blocks are written back from their source.** Every top-level
 *    block remembers the slice of Markdown it came from and the whitespace in
 *    front of it. On save, a block whose document node is unchanged is written
 *    as that slice, byte for byte; only blocks that were edited, added or
 *    moved are serialised afresh, with `remark-stringify` in the style the page
 *    already uses. A page nobody edited therefore comes back identical by
 *    construction, and an edit changes only the blocks it touched.
 *
 * Constructs the editor has no visual form for — raw HTML, link reference
 * definitions, footnotes, a list mixing task and plain items — are kept as
 * verbatim source nodes, never dropped or approximated.
 */

/** One top-level block of the source, and the document node it became. */
export interface SourceSegment {
  /** Whitespace between the previous block (or the start) and this block. */
  gap: string;
  /** The block's Markdown, exactly as it appears in the source. */
  source: string;
  /** Identity of the document node, compared on save. Set by `bindDocument`. */
  key: string;
}

export interface MarkdownStyle {
  bullet: '-' | '*' | '+';
  emphasis: '*' | '_';
  strong: '*' | '_';
  rule: '-' | '*' | '_';
  fence: '`' | '~';
}

export interface ParsedMarkdown {
  doc: JSONContent;
  segments: SourceSegment[];
  /** Whatever follows the last block, usually a newline. */
  tail: string;
  style: MarkdownStyle;
  /** How many top-level blocks are kept as verbatim source. */
  rawBlocks: number;
}

const parser = unified().use(remarkParse).use(remarkGfm).freeze();

/** Raised while converting a block that cannot be represented faithfully. */
class KeepAsSource extends Error {}

function sliceOf(markdown: string, node: Nodes): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) throw new KeepAsSource();
  return markdown.slice(start, end);
}

/* ------------------------------------------------------------------ */
/* Style inference                                                     */
/* ------------------------------------------------------------------ */

function firstNode<T extends Nodes['type']>(node: Nodes, type: T): Extract<Nodes, { type: T }> | null {
  if (node.type === type) return node as Extract<Nodes, { type: T }>;
  if ('children' in node) {
    for (const child of node.children) {
      const found = firstNode(child, type);
      if (found) return found;
    }
  }
  return null;
}

/** The markers a page already uses, so a re-serialised block matches its neighbours. */
export function inferStyle(markdown: string, tree: Root): MarkdownStyle {
  const style: MarkdownStyle = { bullet: '-', emphasis: '*', strong: '*', rule: '-', fence: '`' };
  const charAt = (node: Nodes | null): string | undefined => {
    const offset = node?.position?.start.offset;
    return offset === undefined ? undefined : markdown.charAt(offset);
  };

  const unordered = (function find(node: Nodes): List | null {
    if (node.type === 'list' && !node.ordered) return node;
    if ('children' in node) {
      for (const child of node.children) {
        const found = find(child);
        if (found) return found;
      }
    }
    return null;
  })(tree);
  const bullet = charAt(unordered?.children[0] ?? null);
  if (bullet === '-' || bullet === '*' || bullet === '+') style.bullet = bullet;

  const emphasis = charAt(firstNode(tree, 'emphasis'));
  if (emphasis === '*' || emphasis === '_') style.emphasis = emphasis;
  const strong = charAt(firstNode(tree, 'strong'));
  if (strong === '*' || strong === '_') style.strong = strong;
  const rule = charAt(firstNode(tree, 'thematicBreak'));
  if (rule === '-' || rule === '*' || rule === '_') style.rule = rule;
  const code = firstNode(tree, 'code');
  const fence = charAt(code);
  if (fence === '~') style.fence = '~';
  // A bullet list written with the same character as the rule would read as
  // a rule; remark refuses that combination.
  if (style.bullet === style.rule) style.rule = style.bullet === '-' ? '*' : '-';
  return style;
}

/* ------------------------------------------------------------------ */
/* Markdown → document                                                 */
/* ------------------------------------------------------------------ */

type Mark = { type: string; attrs?: Record<string, unknown> };

interface Converter {
  markdown: string;
  /** Depth of containers around the node being converted. */
  depth: number;
}

function text(value: string, marks: Mark[]): JSONContent | null {
  if (value === '') return null;
  return marks.length > 0 ? { type: 'text', text: value, marks: marks.map((mark) => ({ ...mark })) } : { type: 'text', text: value };
}

function rawInline(ctx: Converter, node: Nodes, marks: Mark[]): JSONContent {
  const source = sliceOf(ctx.markdown, node);
  // Inside a list or a quote, a multi-line slice carries the container's
  // indentation, which would be doubled when written back. The whole
  // top-level block is kept as source instead.
  if (ctx.depth > 0 && source.includes('\n')) throw new KeepAsSource();
  return marks.length > 0 ? { type: 'rawInline', attrs: { source }, marks } : { type: 'rawInline', attrs: { source } };
}

function inline(ctx: Converter, nodes: PhrasingContent[], marks: Mark[] = []): JSONContent[] {
  const out: JSONContent[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text': {
        const converted = text(node.value, marks);
        if (converted) out.push(converted);
        break;
      }
      case 'emphasis':
        out.push(...inline(ctx, node.children, [...marks, { type: 'italic' }]));
        break;
      case 'strong':
        out.push(...inline(ctx, node.children, [...marks, { type: 'bold' }]));
        break;
      case 'delete':
        out.push(...inline(ctx, node.children, [...marks, { type: 'strike' }]));
        break;
      case 'inlineCode': {
        const converted = text(node.value, [...marks, { type: 'code' }]);
        if (converted) out.push(converted);
        else out.push(rawInline(ctx, node, marks));
        break;
      }
      case 'link': {
        // A link nested in a link is not something a document can hold.
        if (marks.some((mark) => mark.type === 'link')) throw new KeepAsSource();
        const children = inline(ctx, node.children, [
          ...marks,
          { type: 'link', attrs: { href: node.url, title: node.title ?? null } },
        ]);
        if (children.length === 0) out.push(rawInline(ctx, node, marks));
        else out.push(...children);
        break;
      }
      case 'image': {
        const image: JSONContent = {
          type: 'image',
          attrs: { src: node.url, alt: node.alt ?? null, title: node.title ?? null },
        };
        if (marks.length > 0) image.marks = marks;
        out.push(image);
        break;
      }
      case 'break':
        out.push(marks.length > 0 ? { type: 'hardBreak', marks } : { type: 'hardBreak' });
        break;
      default:
        // Raw HTML, references to definitions, footnote references.
        out.push(rawInline(ctx, node, marks));
    }
  }
  return out;
}

function paragraph(ctx: Converter, node: Paragraph): JSONContent {
  const content = inline(ctx, node.children);
  return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
}

function nested(ctx: Converter): Converter {
  return { ...ctx, depth: ctx.depth + 1 };
}

function blocks(ctx: Converter, nodes: Array<BlockContent | DefinitionContent>): JSONContent[] {
  return nodes.map((node) => block(ctx, node));
}

function listItemContent(ctx: Converter, item: ListItem): JSONContent[] {
  const [first, ...rest] = item.children;
  // The editor's list item starts with a paragraph; Markdown's may start with
  // anything, or be empty. Those lists are kept as source.
  if (!first || first.type !== 'paragraph') throw new KeepAsSource();
  return [paragraph(ctx, first), ...blocks(ctx, rest)];
}

function list(ctx: Converter, node: List): JSONContent {
  const inner = nested(ctx);
  const checked = node.children.map((item) => item.checked);
  const isTaskList = checked.every((value) => value === true || value === false);
  if (!isTaskList && checked.some((value) => value === true || value === false)) {
    throw new KeepAsSource();
  }
  const spread = Boolean(node.spread) || node.children.some((item) => Boolean(item.spread));

  if (isTaskList && !node.ordered) {
    return {
      type: 'taskList',
      attrs: { spread },
      content: node.children.map((item) => ({
        type: 'taskItem',
        attrs: { checked: item.checked === true },
        content: listItemContent(inner, item),
      })),
    };
  }
  if (isTaskList) throw new KeepAsSource();

  const items = node.children.map((item) => ({ type: 'listItem', content: listItemContent(inner, item) }));
  return node.ordered
    ? { type: 'orderedList', attrs: { start: node.start ?? 1, spread }, content: items }
    : { type: 'bulletList', attrs: { spread }, content: items };
}

function table(ctx: Converter, node: Table): JSONContent {
  const inner = nested(ctx);
  const columns = Math.max(...node.children.map((row) => row.children.length));
  const align = node.align ?? [];
  return {
    type: 'table',
    content: node.children.map((row: TableRow, rowIndex) => {
      const cells: JSONContent[] = [];
      for (let column = 0; column < columns; column += 1) {
        const cell: TableCell | undefined = row.children[column];
        const content = cell ? inline(inner, cell.children) : [];
        cells.push({
          type: rowIndex === 0 ? 'tableHeader' : 'tableCell',
          attrs: { align: align[column] ?? null },
          content: [content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' }],
        });
      }
      return { type: 'tableRow', content: cells };
    }),
  };
}

function code(node: Code): JSONContent {
  if (node.lang === MERMAID_LANGUAGE) {
    return { type: 'mermaidBlock', attrs: { source: node.value, meta: node.meta ?? null } };
  }
  if (node.lang === CHART_LANGUAGE) {
    return { type: 'chartBlock', attrs: { source: node.value, meta: node.meta ?? null } };
  }
  const attrs = { language: node.lang ?? null, meta: node.meta ?? null };
  return node.value === '' ? { type: 'codeBlock', attrs } : { type: 'codeBlock', attrs, content: [{ type: 'text', text: node.value }] };
}

function callout(ctx: Converter, node: Extract<Nodes, { type: 'blockquote' }>): JSONContent | null {
  const [first, ...rest] = node.children;
  if (!first || first.type !== 'paragraph') return null;
  const lead = first.children[0];
  if (!lead || lead.type !== 'text') return null;
  const kind = calloutKindOf(lead.value);
  if (!kind) return null;

  const match = CALLOUT_MARKER.exec(lead.value);
  const remainder = lead.value.slice(match?.[0].length ?? 0);
  const inner = nested(ctx);
  const firstChildren: PhrasingContent[] =
    remainder === '' ? first.children.slice(1) : [{ ...lead, value: remainder }, ...first.children.slice(1)];
  const content: JSONContent[] = [];
  if (firstChildren.length > 0) content.push(paragraph(inner, { ...first, children: firstChildren }));
  content.push(...blocks(inner, rest));
  // An empty callout still needs a line to type into.
  if (content.length === 0) content.push({ type: 'paragraph' });
  return { type: 'callout', attrs: { kind: kind satisfies CalloutKind }, content };
}

function block(ctx: Converter, node: RootContent): JSONContent {
  switch (node.type) {
    case 'paragraph':
      return paragraph(ctx, node);
    case 'heading': {
      const content = inline(ctx, node.children);
      return content.length > 0
        ? { type: 'heading', attrs: { level: node.depth }, content }
        : { type: 'heading', attrs: { level: node.depth } };
    }
    case 'thematicBreak':
      return { type: 'horizontalRule' };
    case 'blockquote': {
      const asCallout = callout(ctx, node);
      if (asCallout) return asCallout;
      if (node.children.length === 0) throw new KeepAsSource();
      return { type: 'blockquote', content: blocks(nested(ctx), node.children) };
    }
    case 'list':
      return list(ctx, node);
    case 'code':
      return code(node);
    case 'table':
      return table(ctx, node);
    default:
      // html, definition, footnoteDefinition and anything a plugin may add.
      throw new KeepAsSource();
  }
}

/** Parses Markdown into an editor document plus the source of every top-level block. */
export function parseMarkdown(markdown: string): ParsedMarkdown {
  const tree = parser.parse(markdown) as Root;
  const style = inferStyle(markdown, tree);
  const segments: SourceSegment[] = [];
  const content: JSONContent[] = [];
  let cursor = 0;
  let rawBlocks = 0;

  for (const child of tree.children) {
    const start = child.position?.start.offset;
    const end = child.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const source = markdown.slice(start, end);
    let node: JSONContent;
    try {
      node = block({ markdown, depth: 0 }, child);
    } catch (error) {
      if (!(error instanceof KeepAsSource)) throw error;
      node = { type: 'rawBlock', attrs: { source } };
      rawBlocks += 1;
    }
    segments.push({ gap: markdown.slice(cursor, start), source, key: '' });
    content.push(node);
    cursor = end;
  }

  return {
    doc: { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] },
    segments,
    tail: markdown.slice(cursor),
    style,
    rawBlocks,
  };
}

/** The identity a top-level node is compared by. */
export function nodeKey(node: JSONContent): string {
  return JSON.stringify(node);
}

/**
 * Records the editor's own version of each top-level node against its source.
 *
 * The editor normalises what it is given — default attributes filled in, for
 * instance — so identity is taken from the document as the editor holds it,
 * not from the JSON handed to it. Returns false when the editor's document does
 * not line up block for block with the source, which means the visual editor
 * cannot promise to keep this page's bytes.
 */
export function bindDocument(parsed: ParsedMarkdown, editorDoc: JSONContent): boolean {
  const nodes = editorDoc.content ?? [];
  if (parsed.segments.length === 0) return true;
  if (nodes.length !== parsed.segments.length) return false;
  parsed.segments.forEach((segment, index) => {
    segment.key = nodeKey(nodes[index] as JSONContent);
  });
  return true;
}

/* ------------------------------------------------------------------ */
/* Document → Markdown                                                 */
/* ------------------------------------------------------------------ */

interface CalloutNode extends Parent {
  type: 'callout';
  kind: string;
  children: Array<BlockContent | DefinitionContent>;
}

declare module 'mdast' {
  interface RootContentMap {
    callout: CalloutNode;
  }
  interface BlockContentMap {
    callout: CalloutNode;
  }
}

function sameMark(a: Mark, b: Mark): boolean {
  return a.type === b.type && JSON.stringify(a.attrs ?? {}) === JSON.stringify(b.attrs ?? {});
}

function markRank(mark: Mark): number {
  const index = (MARK_ORDER as readonly string[]).indexOf(mark.type);
  return index === -1 ? MARK_ORDER.length : index;
}

function markNode(mark: Mark): PhrasingContent & Parents {
  switch (mark.type) {
    case 'link':
      return {
        type: 'link',
        url: String(mark.attrs?.href ?? ''),
        title: typeof mark.attrs?.title === 'string' && mark.attrs.title !== '' ? mark.attrs.title : null,
        children: [],
      };
    case 'bold':
      return { type: 'strong', children: [] };
    case 'italic':
      return { type: 'emphasis', children: [] };
    default:
      return { type: 'delete', children: [] };
  }
}

function leaf(node: JSONContent, isCode: boolean): PhrasingContent | null {
  switch (node.type) {
    case 'text':
      return isCode ? { type: 'inlineCode', value: node.text ?? '' } : { type: 'text', value: node.text ?? '' };
    case 'hardBreak':
      return { type: 'break' };
    case 'image':
      return {
        type: 'image',
        url: String(node.attrs?.src ?? ''),
        alt: typeof node.attrs?.alt === 'string' ? node.attrs.alt : null,
        title: typeof node.attrs?.title === 'string' && node.attrs.title !== '' ? node.attrs.title : null,
      };
    case 'rawInline':
      return { type: 'html', value: String(node.attrs?.source ?? '') };
    default:
      return null;
  }
}

/** Flat, marked inline nodes back into nested Markdown phrasing. */
function toPhrasing(nodes: JSONContent[]): PhrasingContent[] {
  const root: { children: PhrasingContent[] } = { children: [] };
  const stack: Array<{ mark: Mark; node: PhrasingContent & Parents }> = [];

  for (const node of nodes) {
    const all = (node.marks ?? []) as Mark[];
    const isCode = all.some((mark) => mark.type === 'code');
    const marks = all.filter((mark) => mark.type !== 'code').sort((a, b) => markRank(a) - markRank(b));

    let common = 0;
    while (common < stack.length && common < marks.length && sameMark(stack[common]!.mark, marks[common]!)) {
      common += 1;
    }
    stack.length = common;
    let parent: { children: PhrasingContent[] } = common > 0 ? (stack[common - 1]!.node as { children: PhrasingContent[] }) : root;
    for (const mark of marks.slice(common)) {
      const created = markNode(mark);
      parent.children.push(created);
      stack.push({ mark, node: created });
      parent = created as { children: PhrasingContent[] };
    }
    const converted = leaf(node, isCode);
    if (converted) {
      const previous = parent.children[parent.children.length - 1];
      // Adjacent plain text is one text node in Markdown.
      if (converted.type === 'text' && previous?.type === 'text') previous.value += converted.value;
      else parent.children.push(converted);
    }
  }
  return root.children;
}

function toBlock(node: JSONContent): Array<BlockContent | DefinitionContent> {
  const children = node.content ?? [];
  switch (node.type) {
    case 'paragraph':
      return children.length === 0 ? [] : [{ type: 'paragraph', children: toPhrasing(children) }];
    case 'heading':
      return [
        {
          type: 'heading',
          depth: Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1))) as 1 | 2 | 3 | 4 | 5 | 6,
          children: toPhrasing(children),
        },
      ];
    case 'blockquote': {
      const content = children.flatMap(toBlock);
      return content.length === 0 ? [] : [{ type: 'blockquote', children: content }];
    }
    case 'callout':
      return [{ type: 'callout', kind: String(node.attrs?.kind ?? 'NOTE'), children: children.flatMap(toBlock) }];
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      const spread = Boolean(node.attrs?.spread);
      return [
        {
          type: 'list',
          ordered: node.type === 'orderedList',
          start: node.type === 'orderedList' ? Number(node.attrs?.start ?? 1) : null,
          spread,
          children: children.map(
            (item): ListItem => ({
              type: 'listItem',
              spread,
              checked: node.type === 'taskList' ? Boolean(item.attrs?.checked) : null,
              children: (item.content ?? []).flatMap(toBlock),
            }),
          ),
        },
      ];
    }
    case 'codeBlock':
      return [
        {
          type: 'code',
          lang: typeof node.attrs?.language === 'string' && node.attrs.language !== '' ? node.attrs.language : null,
          meta: typeof node.attrs?.meta === 'string' && node.attrs.meta !== '' ? node.attrs.meta : null,
          value: children.map((child) => child.text ?? '').join(''),
        },
      ];
    case 'mermaidBlock':
    case 'chartBlock':
      return [
        {
          type: 'code',
          lang: node.type === 'mermaidBlock' ? MERMAID_LANGUAGE : CHART_LANGUAGE,
          meta: typeof node.attrs?.meta === 'string' && node.attrs.meta !== '' ? node.attrs.meta : null,
          value: String(node.attrs?.source ?? ''),
        },
      ];
    case 'horizontalRule':
      return [{ type: 'thematicBreak' }];
    case 'table': {
      const rows = children;
      const columns = Math.max(1, ...rows.map((row) => (row.content ?? []).length));
      const align: AlignType[] = [];
      const header = rows[0]?.content ?? [];
      for (let column = 0; column < columns; column += 1) {
        const value = header[column]?.attrs?.align;
        align.push(value === 'left' || value === 'center' || value === 'right' ? value : null);
      }
      return [
        {
          type: 'table',
          align,
          children: rows.map((row) => {
            const cells = row.content ?? [];
            return {
              type: 'tableRow',
              children: Array.from({ length: columns }, (_, column) => ({
                type: 'tableCell',
                children: toPhrasing(
                  (cells[column]?.content ?? []).flatMap((cellBlock, index, all) => [
                    ...(cellBlock.content ?? []),
                    // A cell holds one line; pasted multi-paragraph cells are joined.
                    ...(index < all.length - 1 ? [{ type: 'text', text: ' ' }] : []),
                  ]),
                ),
              })),
            };
          }),
        },
      ];
    }
    case 'rawBlock':
      return [{ type: 'html', value: String(node.attrs?.source ?? '') }];
    default:
      return [];
  }
}

type Handle = (node: unknown, parent: unknown, state: State, info: Info) => string;
type State = Parameters<NonNullable<NonNullable<StringifyOptions['handlers']>['blockquote']>>[2];
type Info = Parameters<NonNullable<NonNullable<StringifyOptions['handlers']>['blockquote']>>[3];

const calloutHandler: Handle = (node, _parent, state, info) => {
  const callout = node as CalloutNode;
  const exit = state.enter('blockquote');
  const tracker = state.createTracker(info);
  tracker.move('> ');
  tracker.shift(2);
  const inner = state.containerFlow(callout as unknown as Parameters<State['containerFlow']>[0], tracker.current());
  const body = inner === '' ? `[!${callout.kind}]` : `[!${callout.kind}]\n${inner}`;
  const value = state.indentLines(body, (line, _index, blank) => `>${blank ? '' : ' '}${line}`);
  exit();
  return value;
};

/**
 * Wraps the table serialiser so a delimiter row reads `| --- | :---: |`, the
 * way people and agents write it, rather than remark's one-dash minimum.
 */
function tableHandler(base: Handle): Handle {
  return (node, parent, state, info) => {
    const value = base(node, parent, state, info);
    const lines = value.split('\n');
    if (lines[1] !== undefined) {
      lines[1] = lines[1].replace(/(:?)-+(:?)/g, (_match, left: string, right: string) => `${left}---${right}`);
    }
    return lines.join('\n');
  };
}

interface ToMarkdownExtension {
  handlers?: Record<string, Handle>;
  extensions?: ToMarkdownExtension[];
}

function findHandler(extensions: ToMarkdownExtension[], name: string): Handle | undefined {
  let found: Handle | undefined;
  for (const extension of extensions) {
    // Later extensions override earlier ones, as they do when remark applies them.
    const nestedHandler = extension.extensions ? findHandler(extension.extensions, name) : undefined;
    found = extension.handlers?.[name] ?? nestedHandler ?? found;
  }
  return found;
}

/**
 * A plugin placed after `remark-gfm`: it finds the GFM table serialiser and
 * wraps it, so pipes and alignment keep GFM's escaping rules.
 */
function remarkTableDelimiters(this: unknown): void {
  const data = (this as { data(): Record<string, unknown> }).data();
  const extensions = (data.toMarkdownExtensions ??= []) as ToMarkdownExtension[];
  const base = findHandler(extensions, 'table');
  if (base) extensions.push({ handlers: { table: tableHandler(base) } });
}

function stringifyOptions(style: MarkdownStyle): StringifyOptions {
  return {
    bullet: style.bullet,
    bulletOther: style.bullet === '-' ? '*' : '-',
    emphasis: style.emphasis,
    strong: style.strong,
    rule: style.rule,
    fence: style.fence,
    listItemIndent: 'one',
    incrementListMarker: true,
    setext: false,
    closeAtx: false,
    ruleRepetition: 3,
    ruleSpaces: false,
    handlers: { callout: calloutHandler } as unknown as StringifyOptions['handlers'],
  };
}

const serializers = new Map<string, ReturnType<typeof createSerializer>>();

function createSerializer(style: MarkdownStyle) {
  return unified()
    .use(remarkGfm, { tablePipeAlign: false })
    .use(remarkTableDelimiters)
    .use(remarkStringify, stringifyOptions(style))
    .freeze();
}

/** Serialises a run of document nodes with the page's style. */
export function serializeNodes(nodes: JSONContent[], style: MarkdownStyle): string {
  const tree: Root = { type: 'root', children: nodes.flatMap(toBlock) as RootContent[] };
  if (tree.children.length === 0) return '';
  const key = JSON.stringify(style);
  let serializer = serializers.get(key);
  if (!serializer) {
    serializer = createSerializer(style);
    serializers.set(key, serializer);
  }
  return String(serializer.stringify(tree)).replace(/\n$/, '');
}

function isEmptyParagraph(node: JSONContent): boolean {
  return node.type === 'paragraph' && (node.content ?? []).length === 0;
}

/**
 * Writes an editor document back as Markdown, reusing the source of every
 * top-level block that has not changed.
 */
export function serializeDocument(doc: JSONContent, parsed: ParsedMarkdown): string {
  const nodes = (doc.content ?? []).filter((node) => !isEmptyParagraph(node));
  const { segments } = parsed;

  if (nodes.length === 0) {
    // Nothing left to write. An untouched empty page keeps its whitespace.
    return segments.length === 0 ? parsed.tail : '';
  }

  let out = '';
  let searchFrom = 0;
  let previousMatch = -2;
  let pending: JSONContent[] = [];
  let lastMatchedSegment = -1;

  const separator = () => (out === '' ? '' : '\n\n');
  const flush = () => {
    if (pending.length === 0) return;
    const written = serializeNodes(pending, parsed.style);
    pending = [];
    if (written === '') return;
    out += separator() + written;
    previousMatch = -2;
    lastMatchedSegment = -1;
  };

  for (const node of nodes) {
    const key = nodeKey(node);
    let match = -1;
    for (let index = searchFrom; index < segments.length; index += 1) {
      if (segments[index]!.key === key) {
        match = index;
        break;
      }
    }
    if (match === -1) {
      pending.push(node);
      continue;
    }
    flush();
    const segment = segments[match]!;
    if (out === '') {
      out = match === 0 ? segment.gap + segment.source : segment.source;
    } else {
      out += (match === previousMatch + 1 ? segment.gap : '\n\n') + segment.source;
    }
    previousMatch = match;
    lastMatchedSegment = match;
    searchFrom = match + 1;
  }
  flush();

  if (lastMatchedSegment === segments.length - 1 && segments.length > 0) return out + parsed.tail;
  const originalEndsWithNewline = segments.length === 0 ? true : /\n$/.test(parsed.tail);
  return originalEndsWithNewline ? `${out}\n` : out;
}

/**
 * The whole round trip for a body the editor has not touched: parse, let the
 * caller normalise the document the way the editor would, bind, write back.
 * The editor uses it on open to decide whether the visual tab is safe.
 */
export function roundTrip(markdown: string, normalize: (doc: JSONContent) => JSONContent): {
  parsed: ParsedMarkdown;
  doc: JSONContent;
  output: string;
  bound: boolean;
} {
  const parsed = parseMarkdown(markdown);
  const doc = normalize(parsed.doc);
  const bound = bindDocument(parsed, doc);
  return { parsed, doc, output: bound ? serializeDocument(doc, parsed) : '', bound };
}
