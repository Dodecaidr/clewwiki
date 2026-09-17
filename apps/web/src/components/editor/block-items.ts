import { EDITOR_CALLOUTS } from '@clewwiki/content/callouts';
import type { Editor } from '@tiptap/core';

import { insertTable, setCallout } from './commands';

/**
 * The blocks a writer can insert, shared by the slash menu and the toolbar so
 * both offer the same things and insert them the same way.
 */

export interface BlockItemActions {
  openImage: () => void;
  openMermaid: () => void;
  openChart: () => void;
}

export interface BlockItem {
  id: string;
  /** Message key under `editor`. */
  labelKey: string;
  /** Extra words the slash menu matches on, in English and Russian. */
  keywords: string;
  run: (editor: Editor, actions: BlockItemActions) => void;
}

export const BLOCK_ITEMS: readonly BlockItem[] = [
  { id: 'paragraph', labelKey: 'paragraph', keywords: 'text paragraph текст абзац', run: (editor) => editor.chain().focus().setParagraph().run() },
  { id: 'h1', labelKey: 'heading1', keywords: 'h1 title heading заголовок', run: (editor) => editor.chain().focus().setHeading({ level: 1 }).run() },
  { id: 'h2', labelKey: 'heading2', keywords: 'h2 heading section заголовок раздел', run: (editor) => editor.chain().focus().setHeading({ level: 2 }).run() },
  { id: 'h3', labelKey: 'heading3', keywords: 'h3 heading subsection заголовок подраздел', run: (editor) => editor.chain().focus().setHeading({ level: 3 }).run() },
  { id: 'bullet', labelKey: 'bulletList', keywords: 'bullet list ul unordered список маркированный', run: (editor) => editor.chain().focus().toggleBulletList().run() },
  { id: 'ordered', labelKey: 'orderedList', keywords: 'numbered ordered list ol нумерованный список', run: (editor) => editor.chain().focus().toggleOrderedList().run() },
  { id: 'task', labelKey: 'taskList', keywords: 'task todo checklist checkbox задачи чеклист', run: (editor) => editor.chain().focus().toggleTaskList().run() },
  { id: 'quote', labelKey: 'blockquote', keywords: 'quote blockquote цитата', run: (editor) => editor.chain().focus().toggleBlockquote().run() },
  ...EDITOR_CALLOUTS.map(
    ({ tone, kind }): BlockItem => ({
      id: `callout-${tone}`,
      labelKey: `callout_${tone}`,
      keywords: `callout alert admonition ${tone} ${kind.toLowerCase()} выноска предупреждение`,
      run: (editor) => {
        setCallout(editor, kind);
      },
    }),
  ),
  { id: 'code', labelKey: 'codeBlock', keywords: 'code block fence snippet код', run: (editor) => editor.chain().focus().toggleCodeBlock().run() },
  { id: 'table', labelKey: 'table', keywords: 'table grid таблица', run: (editor) => { insertTable(editor, 3, 3); } },
  { id: 'image', labelKey: 'image', keywords: 'image picture img картинка изображение', run: (_editor, actions) => actions.openImage() },
  { id: 'mermaid', labelKey: 'mermaid', keywords: 'mermaid diagram flowchart sequence диаграмма схема', run: (_editor, actions) => actions.openMermaid() },
  { id: 'chart', labelKey: 'chart', keywords: 'chart graph bar line pie plot график диаграмма', run: (_editor, actions) => actions.openChart() },
  { id: 'rule', labelKey: 'horizontalRule', keywords: 'divider rule hr line separator разделитель', run: (editor) => editor.chain().focus().setHorizontalRule().run() },
];

/** Items matching what was typed after `/`, by label or keyword. */
export function filterBlockItems(query: string, labelOf: (item: BlockItem) => string): BlockItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...BLOCK_ITEMS];
  // Items whose name starts with what was typed come first, then words that
  // start with it, then anything that merely contains it.
  const rank = (item: BlockItem): number => {
    const label = labelOf(item).toLowerCase();
    const words = `${label} ${item.keywords} ${item.id}`.toLowerCase();
    if (label.startsWith(needle) || item.id.startsWith(needle)) return 0;
    if (words.split(/[\s-]+/).some((word) => word.startsWith(needle))) return 1;
    return words.includes(needle) ? 2 : -1;
  };
  return BLOCK_ITEMS.map((item, index) => ({ item, index, score: rank(item) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.item);
}
