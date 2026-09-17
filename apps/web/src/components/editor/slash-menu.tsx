'use client';

import { Extension } from '@tiptap/core';
import type { Editor, Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef } from 'react';

import type { BlockItem } from './block-items';
import { cn } from '@/lib/utils';

/**
 * The "/" menu: type a slash, then a few letters, and pick a block.
 *
 * ProseMirror owns the text and the key presses; React owns the list. The
 * suggestion plugin reports what was typed and where, the list is rendered
 * from that, and the plugin hands arrow keys, Enter and Escape to the menu
 * while it is open.
 */

export interface SlashMenuState {
  open: boolean;
  items: BlockItem[];
  index: number;
  query: string;
  rect: DOMRect | null;
  range: Range | null;
}

export const CLOSED_SLASH_MENU: SlashMenuState = {
  open: false,
  items: [],
  index: 0,
  query: '',
  rect: null,
  range: null,
};

export interface SlashMenuBridge {
  items: (query: string) => BlockItem[];
  update: (state: SlashMenuState | ((previous: SlashMenuState) => SlashMenuState)) => void;
  choose: (editor: Editor, range: Range, item: BlockItem) => void;
  /** The current menu state, read synchronously by the key handler. */
  current: () => SlashMenuState;
}

export function createSlashCommand(bridge: SlashMenuBridge) {
  return Extension.create({
    name: 'slashCommand',
    addProseMirrorPlugins() {
      const editor = this.editor;
      return [
        Suggestion<BlockItem, BlockItem>({
          editor,
          pluginKey: new PluginKey('slashCommand'),
          char: '/',
          allowSpaces: false,
          // Not inside code, where a slash is just a slash.
          allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
          items: ({ query }) => bridge.items(query),
          command: ({ range, props }) => bridge.choose(editor, range, props),
          render: () => ({
            onStart: (props) =>
              bridge.update({
                open: true,
                items: props.items,
                index: 0,
                query: props.query,
                rect: props.clientRect?.() ?? null,
                range: props.range,
              }),
            onUpdate: (props) =>
              bridge.update((previous) => ({
                open: true,
                items: props.items,
                index: Math.min(previous.index, Math.max(0, props.items.length - 1)),
                query: props.query,
                rect: props.clientRect?.() ?? null,
                range: props.range,
              })),
            onExit: () => bridge.update(CLOSED_SLASH_MENU),
            onKeyDown: ({ event }) => {
              const state = bridge.current();
              if (!state.open) return false;
              if (event.key === 'Escape') {
                bridge.update(CLOSED_SLASH_MENU);
                return true;
              }
              if (state.items.length === 0) return false;
              if (event.key === 'ArrowDown') {
                bridge.update({ ...state, index: (state.index + 1) % state.items.length });
                return true;
              }
              if (event.key === 'ArrowUp') {
                bridge.update({ ...state, index: (state.index - 1 + state.items.length) % state.items.length });
                return true;
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                const item = state.items[state.index];
                if (item && state.range) bridge.choose(editor, state.range, item);
                return true;
              }
              return false;
            },
          }),
        }),
      ];
    },
  });
}

export function SlashMenu({
  state,
  onChoose,
  onHover,
}: {
  state: SlashMenuState;
  onChoose: (item: BlockItem) => void;
  onHover: (index: number) => void;
}) {
  const t = useTranslations('editor');
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${state.index}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [state.index]);

  if (!state.open || !state.rect) return null;

  // Below the cursor when it fits, above it when it does not.
  const menuHeight = 300;
  const top =
    state.rect.bottom + 6 + menuHeight > window.innerHeight
      ? state.rect.top - 6 - menuHeight
      : state.rect.bottom + 6;
  const left = Math.min(state.rect.left, window.innerWidth - 272);

  return (
    <div
      className="fixed z-50 w-64 rounded-(--radius-base) border border-border bg-card p-1 text-sm text-card-foreground shadow-lg"
      style={{ top: Math.max(8, top), left: Math.max(8, left) }}
    >
      <p id={`${listId}-label`} className="px-2 py-1 text-xs text-muted-foreground">
        {t('slashMenuLabel')}
      </p>
      {state.items.length === 0 ? (
        <p className="px-2 py-1.5 text-muted-foreground">{t('slashNoResults', { query: state.query })}</p>
      ) : (
        <ul
          ref={listRef}
          role="listbox"
          aria-labelledby={`${listId}-label`}
          className="max-h-64 overflow-y-auto"
        >
          {state.items.map((item, index) => (
            <li
              key={item.id}
              role="option"
              aria-selected={index === state.index}
              data-index={index}
              className={cn(
                'cursor-pointer rounded-(--radius-base) px-2 py-1.5',
                index === state.index ? 'bg-secondary text-secondary-foreground' : 'hover:bg-secondary',
              )}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => {
                // Keep the editor's selection where the slash was typed.
                event.preventDefault();
                onChoose(item);
              }}
            >
              {t(item.labelKey)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
