import { Extension, mergeAttributes, Node } from '@tiptap/core';
import type { AnyExtension, NodeViewRenderer } from '@tiptap/core';
import Code from '@tiptap/extension-code';
import CodeBlock from '@tiptap/extension-code-block';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import StarterKit from '@tiptap/starter-kit';
import { CALLOUT_KINDS } from '@clewwiki/content/callouts';
import type { CalloutKind } from '@clewwiki/content/callouts';

/**
 * The visual editor's document model.
 *
 * It holds exactly what a Markdown page can hold, and nothing a Markdown page
 * cannot: there is no font, size, colour or underline, because none of them
 * survive being written back as Markdown and an agent reading the page would
 * never see them. Everything here maps one-to-one onto a Markdown construct in
 * `markdown-bridge.ts`, and anything Markdown can express that has no visual
 * form is kept as a verbatim source node (`rawBlock`, `rawInline`) rather than
 * dropped or approximated.
 *
 * This module has no DOM and no React in it, so the bridge's round-trip tests
 * build the real schema from it. Node views are attached by the React layer
 * through `views`.
 */

export interface EditorViews {
  mermaidBlock?: NodeViewRenderer;
  chartBlock?: NodeViewRenderer;
  rawBlock?: NodeViewRenderer;
  rawInline?: NodeViewRenderer;
  /** Callout titles shown in the editor, by kind. */
  calloutLabels?: Partial<Record<CalloutKind, string>>;
}

/** `spread` records a loose list (blank lines between items) so it is written back loose. */
const spreadAttribute = {
  spread: {
    default: false,
    parseHTML: () => false,
    renderHTML: () => ({}),
  },
};

function atomSourceNode(options: {
  name: 'mermaidBlock' | 'chartBlock' | 'rawBlock';
  dataAttribute: string;
  view?: NodeViewRenderer;
  withMeta?: boolean;
}) {
  return Node.create({
    name: options.name,
    group: 'block',
    atom: true,
    selectable: true,
    draggable: true,
    code: true,
    defining: true,
    addAttributes() {
      return {
        source: {
          default: '',
          parseHTML: (element: HTMLElement) => element.textContent ?? '',
          renderHTML: () => ({}),
        },
        ...(options.withMeta
          ? { meta: { default: null, parseHTML: () => null, renderHTML: () => ({}) } }
          : {}),
      };
    },
    parseHTML() {
      return [{ tag: `pre[${options.dataAttribute}]` }];
    },
    renderHTML({ node, HTMLAttributes }) {
      return ['pre', mergeAttributes(HTMLAttributes, { [options.dataAttribute]: '' }), String(node.attrs.source)];
    },
    ...(options.view ? { addNodeView: () => options.view as NodeViewRenderer } : {}),
  });
}

export const CALLOUT_NODE = 'callout';

function calloutNode(labels: Partial<Record<CalloutKind, string>> = {}) {
  return Node.create({
    name: CALLOUT_NODE,
    group: 'block',
    content: 'block+',
    defining: true,
    addAttributes() {
      return {
        kind: {
          default: 'NOTE' satisfies CalloutKind,
          parseHTML: (element: HTMLElement) => {
            const value = (element.getAttribute('data-callout') ?? '').toUpperCase();
            return (CALLOUT_KINDS as readonly string[]).includes(value) ? value : 'NOTE';
          },
          renderHTML: (attributes: { kind: string }) => ({ 'data-callout': attributes.kind }),
        },
      };
    },
    parseHTML() {
      return [{ tag: 'div[data-callout]' }];
    },
    renderHTML({ HTMLAttributes }) {
      const kind = String(HTMLAttributes['data-callout'] ?? 'NOTE') as CalloutKind;
      return [
        'div',
        mergeAttributes(HTMLAttributes, {
          class: `callout callout-${kind.toLowerCase()}`,
          'data-label': labels[kind] ?? kind,
        }),
        0,
      ];
    },
  });
}

function rawInlineNode(view?: NodeViewRenderer) {
  return Node.create({
    name: 'rawInline',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    addAttributes() {
      return {
        source: { default: '', parseHTML: (element: HTMLElement) => element.textContent ?? '', renderHTML: () => ({}) },
      };
    },
    parseHTML() {
      return [{ tag: 'code[data-raw-inline]' }];
    },
    renderHTML({ node, HTMLAttributes }) {
      return ['code', mergeAttributes(HTMLAttributes, { 'data-raw-inline': '' }), String(node.attrs.source)];
    },
    ...(view ? { addNodeView: () => view } : {}),
  });
}

/** Only web and relative addresses become images; `data:` and `javascript:` do not. */
export function isAllowedImageSource(src: string): boolean {
  const value = src.trim();
  if (value === '') return false;
  if (/^https?:\/\//i.test(value)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('//');
}

export function createEditorExtensions(views: EditorViews = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      // Not Markdown: an underline has nowhere to go in the stored page.
      underline: false,
      // It appends an empty paragraph to every document whose last block is not
      // one, which would count as an edit on a page nobody touched.
      trailingNode: false,
      code: false,
      codeBlock: false,
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null },
      },
      bulletList: {},
      orderedList: {},
    }),
    // Inline code may sit inside a link or emphasis, as it can in Markdown
    // (`[`wiki.claim`](…)` is common in technical pages).
    Code.extend({ excludes: '' }),
    CodeBlock.extend({
      addAttributes() {
        return {
          ...this.parent?.(),
          // Everything after the language on the fence line, such as
          // `title="src/auth.ts"`, kept verbatim.
          meta: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
        };
      },
    }).configure({ defaultLanguage: null, enableTabIndentation: true }),
    Table.configure({ resizable: false }),
    TableRow,
    // A Markdown table cell holds one line of inline content.
    TableHeader.extend({ content: 'paragraph' }),
    TableCell.extend({ content: 'paragraph' }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Image.configure({ inline: true, allowBase64: false }).extend({
      parseHTML() {
        return [
          {
            tag: 'img[src]',
            getAttrs: (element: HTMLElement) =>
              isAllowedImageSource(element.getAttribute('src') ?? '') ? null : false,
          },
        ];
      },
    }),
    calloutNode(views.calloutLabels),
    atomSourceNode({ name: 'mermaidBlock', dataAttribute: 'data-mermaid', view: views.mermaidBlock, withMeta: true }),
    atomSourceNode({ name: 'chartBlock', dataAttribute: 'data-chart', view: views.chartBlock, withMeta: true }),
    atomSourceNode({ name: 'rawBlock', dataAttribute: 'data-raw-block', view: views.rawBlock }),
    rawInlineNode(views.rawInline),
    Extension.create({
      name: 'listSpread',
      addGlobalAttributes() {
        return [{ types: ['bulletList', 'orderedList', 'taskList'], attributes: spreadAttribute }];
      },
    }),
  ];
}

/** Marks that exist in the schema, outermost first when written as Markdown. */
export const MARK_ORDER = ['link', 'bold', 'italic', 'strike', 'code'] as const;
