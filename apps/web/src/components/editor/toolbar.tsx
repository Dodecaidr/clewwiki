'use client';

import { EDITOR_CALLOUTS } from '@clewwiki/content/callouts';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { ReactNode } from 'react';

import type { BlockItemActions } from './block-items';
import { CODE_LANGUAGES, insertTable, removeCallout, setCallout, setColumnAlign } from './commands';
import type { ColumnAlign } from './commands';
import { cn } from '@/lib/utils';

/**
 * The formatting toolbar. Every control has a visible or accessible name and,
 * where there is one, its keyboard shortcut in the tooltip; toggles report
 * their state with `aria-pressed`. Controls that only make sense in a table or
 * a code block appear when the cursor is in one.
 */

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const ALT = IS_MAC ? '⌥' : 'Alt';

function ToolButton({
  label,
  shortcut,
  pressed,
  disabled,
  onClick,
  children,
  wide,
}: {
  label: string;
  shortcut?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-pressed={pressed}
      disabled={disabled}
      // Keep the editor's selection: a toolbar click must act on it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center justify-center rounded-(--radius-base) text-sm transition-colors',
        wide ? 'px-2' : 'min-w-8 px-1.5',
        'hover:bg-secondary disabled:pointer-events-none disabled:opacity-40',
        pressed && 'bg-secondary font-semibold text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function Separator() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />;
}

function Menu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="relative"
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary
        className="inline-flex h-8 cursor-pointer list-none items-center rounded-(--radius-base) px-2 text-sm hover:bg-secondary"
        onMouseDown={(event) => event.preventDefault()}
      >
        {label} <span aria-hidden="true" className="ml-1 text-xs">▾</span>
      </summary>
      {open ? (
        <div className="absolute left-0 z-20 mt-1 grid min-w-44 gap-0.5 rounded-(--radius-base) border border-border bg-card p-1 shadow-md">
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </details>
  );
}

function MenuItem({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="rounded-(--radius-base) px-2 py-1.5 text-left text-sm hover:bg-secondary"
    >
      {children}
    </button>
  );
}

const TABLE_PICKER_SIZE = 8;

function TablePicker({ onPick }: { onPick: (rows: number, columns: number) => void }) {
  const t = useTranslations('editor');
  const [hover, setHover] = useState({ rows: 3, columns: 3 });
  return (
    <div className="grid gap-2 p-1">
      <div
        role="group"
        aria-label={t('tableSize')}
        className="grid gap-0.5"
        style={{ gridTemplateColumns: `repeat(${TABLE_PICKER_SIZE}, 1.25rem)` }}
      >
        {Array.from({ length: TABLE_PICKER_SIZE * TABLE_PICKER_SIZE }, (_, index) => {
          const rows = Math.floor(index / TABLE_PICKER_SIZE) + 1;
          const columns = (index % TABLE_PICKER_SIZE) + 1;
          const active = rows <= hover.rows && columns <= hover.columns;
          return (
            <button
              key={index}
              type="button"
              aria-label={t('tableInsert', { rows, columns })}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setHover({ rows, columns })}
              onFocus={() => setHover({ rows, columns })}
              onClick={() => onPick(rows, columns)}
              className={cn('size-5 rounded-sm border', active ? 'border-primary bg-primary/30' : 'border-border')}
            />
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {t('tableInsert', { rows: hover.rows, columns: hover.columns })}
      </p>
    </div>
  );
}

export function Toolbar({
  editor,
  actions,
  onLink,
}: {
  editor: Editor;
  actions: BlockItemActions;
  onLink: () => void;
}) {
  const t = useTranslations('editor');
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      paragraph: current.isActive('paragraph'),
      h1: current.isActive('heading', { level: 1 }),
      h2: current.isActive('heading', { level: 2 }),
      h3: current.isActive('heading', { level: 3 }),
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      strike: current.isActive('strike'),
      code: current.isActive('code'),
      link: current.isActive('link'),
      bullet: current.isActive('bulletList'),
      ordered: current.isActive('orderedList'),
      task: current.isActive('taskList'),
      quote: current.isActive('blockquote'),
      callout: current.isActive('callout'),
      codeBlock: current.isActive('codeBlock'),
      language: String(current.getAttributes('codeBlock').language ?? ''),
      table: current.isActive('table'),
      canUndo: current.can().undo(),
      canRedo: current.can().redo(),
    }),
  });

  const chain = () => editor.chain().focus();
  const blockType = state.h1 ? 'h1' : state.h2 ? 'h2' : state.h3 ? 'h3' : 'paragraph';

  return (
    <div className="grid gap-1 border-b border-border bg-muted/40 px-2 py-1.5">
      <div role="toolbar" aria-label={t('toolbarLabel')} className="flex flex-wrap items-center gap-0.5">
        <label className="sr-only" htmlFor="editor-block-type">
          {t('blockType')}
        </label>
        <select
          id="editor-block-type"
          value={blockType}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'paragraph') chain().setParagraph().run();
            else chain().setHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 }).run();
          }}
          className="h-8 rounded-(--radius-base) border border-input bg-card px-2 text-sm"
        >
          <option value="paragraph">{t('paragraph')}</option>
          <option value="h1">{t('heading1')}</option>
          <option value="h2">{t('heading2')}</option>
          <option value="h3">{t('heading3')}</option>
        </select>

        <Separator />
        <ToolButton label={t('bold')} shortcut={`${MOD}+B`} pressed={state.bold} onClick={() => chain().toggleBold().run()}>
          <strong>B</strong>
        </ToolButton>
        <ToolButton label={t('italic')} shortcut={`${MOD}+I`} pressed={state.italic} onClick={() => chain().toggleItalic().run()}>
          <em>I</em>
        </ToolButton>
        <ToolButton label={t('strike')} shortcut={`${MOD}+Shift+S`} pressed={state.strike} onClick={() => chain().toggleStrike().run()}>
          <s>S</s>
        </ToolButton>
        <ToolButton label={t('inlineCode')} shortcut={`${MOD}+E`} pressed={state.code} onClick={() => chain().toggleCode().run()}>
          <code className="font-mono text-xs">{'</>'}</code>
        </ToolButton>
        <ToolButton label={t('link')} shortcut={`${MOD}+K`} pressed={state.link} onClick={onLink} wide>
          {t('linkShort')}
        </ToolButton>

        <Separator />
        <ToolButton label={t('bulletList')} shortcut={`${MOD}+Shift+8`} pressed={state.bullet} onClick={() => chain().toggleBulletList().run()}>
          •≡
        </ToolButton>
        <ToolButton label={t('orderedList')} shortcut={`${MOD}+Shift+7`} pressed={state.ordered} onClick={() => chain().toggleOrderedList().run()}>
          1≡
        </ToolButton>
        <ToolButton label={t('taskList')} shortcut={`${MOD}+Shift+9`} pressed={state.task} onClick={() => chain().toggleTaskList().run()}>
          ☑
        </ToolButton>
        <ToolButton label={t('blockquote')} shortcut={`${MOD}+Shift+B`} pressed={state.quote} onClick={() => chain().toggleBlockquote().run()}>
          ❝
        </ToolButton>
        <Menu label={t('callout')}>
          {(close) => (
            <>
              {EDITOR_CALLOUTS.map(({ tone, kind }) => (
                <MenuItem
                  key={kind}
                  onClick={() => {
                    setCallout(editor, kind);
                    close();
                  }}
                >
                  <span className={cn('mr-2 inline-block size-2 rounded-full', `callout-dot-${tone}`)} aria-hidden="true" />
                  {t(`callout_${tone}`)}
                </MenuItem>
              ))}
              {state.callout ? (
                <MenuItem
                  onClick={() => {
                    removeCallout(editor);
                    close();
                  }}
                >
                  {t('calloutRemove')}
                </MenuItem>
              ) : null}
            </>
          )}
        </Menu>
        <ToolButton label={t('horizontalRule')} onClick={() => chain().setHorizontalRule().run()}>
          ―
        </ToolButton>

        <Separator />
        <ToolButton label={t('codeBlock')} shortcut={`${MOD}+${ALT}+C`} pressed={state.codeBlock} onClick={() => chain().toggleCodeBlock().run()} wide>
          {'{ }'}
        </ToolButton>
        <Menu label={t('table')}>
          {(close) => (
            <TablePicker
              onPick={(rows, columns) => {
                insertTable(editor, rows, columns);
                close();
              }}
            />
          )}
        </Menu>
        <ToolButton label={t('image')} onClick={actions.openImage} wide>
          {t('image')}
        </ToolButton>
        <ToolButton label={t('mermaid')} onClick={actions.openMermaid} wide>
          {t('mermaid')}
        </ToolButton>
        <ToolButton label={t('chart')} onClick={actions.openChart} wide>
          {t('chart')}
        </ToolButton>

        <Separator />
        <ToolButton label={t('undo')} shortcut={`${MOD}+Z`} disabled={!state.canUndo} onClick={() => chain().undo().run()}>
          ↶
        </ToolButton>
        <ToolButton label={t('redo')} shortcut={`${MOD}+Shift+Z`} disabled={!state.canRedo} onClick={() => chain().redo().run()}>
          ↷
        </ToolButton>
        <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">{t('slashHint')}</span>
      </div>

      {state.codeBlock ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="editor-code-language" className="text-xs text-muted-foreground">
            {t('codeLanguage')}
          </label>
          <input
            id="editor-code-language"
            list="editor-code-languages"
            value={state.language}
            placeholder={t('codeLanguageNone')}
            onChange={(event) =>
              editor
                .chain()
                .updateAttributes('codeBlock', { language: event.target.value.trim() === '' ? null : event.target.value.trim() })
                .run()
            }
            onKeyDown={(event) => {
              // The editor sits inside the page form; Enter here must not save the page.
              if (event.key === 'Enter') {
                event.preventDefault();
                editor.commands.focus();
              }
            }}
            className="h-8 w-40 rounded-(--radius-base) border border-input bg-card px-2 font-mono text-xs"
          />
          <datalist id="editor-code-languages">
            {CODE_LANGUAGES.map((language) => (
              <option key={language} value={language} />
            ))}
          </datalist>
        </div>
      ) : null}

      {state.table ? (
        <div role="toolbar" aria-label={t('tableToolbar')} className="flex flex-wrap items-center gap-0.5 text-sm">
          <ToolButton label={t('tableRowBefore')} onClick={() => chain().addRowBefore().run()} wide>
            {t('tableRowBefore')}
          </ToolButton>
          <ToolButton label={t('tableRowAfter')} onClick={() => chain().addRowAfter().run()} wide>
            {t('tableRowAfter')}
          </ToolButton>
          <ToolButton label={t('tableRowDelete')} onClick={() => chain().deleteRow().run()} wide>
            {t('tableRowDelete')}
          </ToolButton>
          <Separator />
          <ToolButton label={t('tableColumnBefore')} onClick={() => chain().addColumnBefore().run()} wide>
            {t('tableColumnBefore')}
          </ToolButton>
          <ToolButton label={t('tableColumnAfter')} onClick={() => chain().addColumnAfter().run()} wide>
            {t('tableColumnAfter')}
          </ToolButton>
          <ToolButton label={t('tableColumnDelete')} onClick={() => chain().deleteColumn().run()} wide>
            {t('tableColumnDelete')}
          </ToolButton>
          <Separator />
          {(
            [
              ['left', t('tableAlignLeft'), '⇤'],
              ['center', t('tableAlignCenter'), '↔'],
              ['right', t('tableAlignRight'), '⇥'],
              [null, t('tableAlignNone'), '∅'],
            ] as Array<[ColumnAlign, string, string]>
          ).map(([align, label, glyph]) => (
            <ToolButton key={String(align)} label={label} onClick={() => setColumnAlign(editor, align)}>
              {glyph}
            </ToolButton>
          ))}
          <Separator />
          <ToolButton label={t('tableDelete')} onClick={() => chain().deleteTable().run()} wide>
            {t('tableDelete')}
          </ToolButton>
          <span className="text-xs text-muted-foreground">{t('tableHeaderNote')}</span>
        </div>
      ) : null}
    </div>
  );
}
