import type { CalloutKind } from '@clewwiki/content/callouts';
import type { Editor } from '@tiptap/core';
import { selectedRect } from '@tiptap/pm/tables';

/**
 * Editor commands the toolbar, the slash menu and the keyboard share, so a
 * block inserted from any of them is the same block.
 */

export type ColumnAlign = 'left' | 'center' | 'right' | null;

/**
 * Sets the alignment of every column the selection touches. Markdown aligns
 * whole columns — the delimiter row has one entry per column — so a single
 * cell cannot be aligned on its own.
 */
export function setColumnAlign(editor: Editor, align: ColumnAlign): boolean {
  const { state, view } = editor;
  let rect;
  try {
    rect = selectedRect(state);
  } catch {
    return false;
  }
  const { map, tableStart, left, right } = rect;
  const tr = state.tr;
  for (let column = left; column < right; column += 1) {
    for (let row = 0; row < map.height; row += 1) {
      const offset = map.map[row * map.width + column];
      if (offset === undefined) continue;
      const position = tableStart + offset;
      const cell = tr.doc.nodeAt(position);
      if (!cell) continue;
      tr.setNodeMarkup(position, undefined, { ...cell.attrs, align });
    }
  }
  view.dispatch(tr);
  view.focus();
  return true;
}

/** Wraps the selection in a callout, or changes the kind of the one it is in. */
export function setCallout(editor: Editor, kind: CalloutKind): boolean {
  if (editor.isActive('callout')) {
    return editor.chain().focus().updateAttributes('callout', { kind }).run();
  }
  return editor.chain().focus().wrapIn('callout', { kind }).run();
}

export function removeCallout(editor: Editor): boolean {
  return editor.chain().focus().lift('callout').run();
}

export function insertMermaid(editor: Editor, source: string): boolean {
  return editor
    .chain()
    .focus()
    .insertContent({ type: 'mermaidBlock', attrs: { source, meta: null } })
    .run();
}

export function insertChart(editor: Editor, source: string): boolean {
  return editor
    .chain()
    .focus()
    .insertContent({ type: 'chartBlock', attrs: { source, meta: null } })
    .run();
}

export function insertTable(editor: Editor, rows: number, columns: number): boolean {
  return editor.chain().focus().insertTable({ rows, cols: columns, withHeaderRow: true }).run();
}

/** Addresses a link may point at: the web, mail, and paths on this instance. */
export function isAllowedLinkTarget(href: string): boolean {
  const value = href.trim();
  if (value === '') return false;
  if (/^(https?:|mailto:)/i.test(value)) return true;
  if (value.startsWith('#') || (value.startsWith('/') && !value.startsWith('//'))) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('//');
}

export function setLink(editor: Editor, href: string): boolean {
  if (href.trim() === '') {
    return editor.chain().focus().extendMarkRange('link').unsetLink().run();
  }
  if (!isAllowedLinkTarget(href)) return false;
  return editor.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run();
}

/** Common languages for the code block picker; any other name can be typed. */
export const CODE_LANGUAGES = [
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'diff',
  'dockerfile',
  'go',
  'graphql',
  'html',
  'java',
  'javascript',
  'json',
  'kotlin',
  'markdown',
  'php',
  'python',
  'ruby',
  'rust',
  'sh',
  'sql',
  'swift',
  'toml',
  'ts',
  'tsx',
  'typescript',
  'xml',
  'yaml',
] as const;
