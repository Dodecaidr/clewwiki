'use client';

import { checkMermaidSource } from '@clewwiki/content/mermaid';
import { NodeViewWrapper } from '@tiptap/react';
import type { ReactNodeViewProps } from '@tiptap/react';
import { useTranslations } from 'next-intl';
import { createContext, useContext } from 'react';

import { ChartPreview } from './chart-preview';
import { MermaidPreview } from './mermaid-preview';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * How a block asks the editor to open its dialog. The dialogs live beside the
 * editor rather than inside the block, so they are rendered once and outside
 * the editable area.
 */
export interface EditorUi {
  editMermaid: (source: string, save: (source: string) => void) => void;
  editChart: (source: string, save: (source: string) => void) => void;
  editSource: (source: string, save: (source: string) => void) => void;
}

export const EditorUiContext = createContext<EditorUi | null>(null);

function useEditorUi(): EditorUi {
  const ui = useContext(EditorUiContext);
  if (!ui) throw new Error('Editor blocks must be rendered inside the visual editor');
  return ui;
}

function BlockFrame({
  label,
  selected,
  invalid,
  onEdit,
  onDelete,
  editLabel,
  deleteLabel,
  children,
}: {
  label: string;
  selected: boolean;
  invalid?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  editLabel: string;
  deleteLabel: string;
  children: React.ReactNode;
}) {
  return (
    <NodeViewWrapper
      className={cn(
        'my-4 rounded-(--radius-base) border bg-card',
        selected ? 'border-ring ring-2 ring-ring/30' : 'border-border',
        invalid && 'border-destructive/60',
      )}
      data-drag-handle=""
    >
      <div
        contentEditable={false}
        className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground"
      >
        <span className="font-medium">{label}</span>
        <span className="flex gap-1">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onEdit}>
            {editLabel}
          </Button>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onDelete}>
            {deleteLabel}
          </Button>
        </span>
      </div>
      <div contentEditable={false} className="p-3 [--chart-surface:var(--color-card)]" onDoubleClick={onEdit}>
        {children}
      </div>
    </NodeViewWrapper>
  );
}

export function MermaidBlockView({ node, updateAttributes, deleteNode, selected }: ReactNodeViewProps) {
  const t = useTranslations('editor');
  const ui = useEditorUi();
  const source = String(node.attrs.source ?? '');
  const issues = checkMermaidSource(source);
  return (
    <BlockFrame
      label={t('mermaidBlockLabel')}
      selected={selected}
      invalid={issues.length > 0}
      editLabel={t('blockEdit')}
      deleteLabel={t('blockDelete')}
      onDelete={deleteNode}
      onEdit={() => ui.editMermaid(source, (next) => updateAttributes({ source: next }))}
    >
      {issues.length > 0 ? (
        <p role="alert" className="text-sm text-destructive">
          {issues[0]?.message}
        </p>
      ) : (
        <MermaidPreview
          source={source}
          labels={{ rendering: t('mermaidRendering'), failed: (message) => t('mermaidFailed', { message }) }}
        />
      )}
    </BlockFrame>
  );
}

export function ChartBlockView({ node, updateAttributes, deleteNode, selected }: ReactNodeViewProps) {
  const t = useTranslations('editor');
  const ui = useEditorUi();
  const source = String(node.attrs.source ?? '');
  return (
    <BlockFrame
      label={t('chartBlockLabel')}
      selected={selected}
      editLabel={t('blockEdit')}
      deleteLabel={t('blockDelete')}
      onDelete={deleteNode}
      onEdit={() => ui.editChart(source, (next) => updateAttributes({ source: next }))}
    >
      <ChartPreview source={source} invalidLabel={t('chartErrors')} />
    </BlockFrame>
  );
}

export function RawBlockView({ node, updateAttributes, deleteNode, selected }: ReactNodeViewProps) {
  const t = useTranslations('editor');
  const ui = useEditorUi();
  const source = String(node.attrs.source ?? '');
  return (
    <BlockFrame
      label={t('rawBlockLabel')}
      selected={selected}
      editLabel={t('blockEdit')}
      deleteLabel={t('blockDelete')}
      onDelete={deleteNode}
      onEdit={() => ui.editSource(source, (next) => updateAttributes({ source: next }))}
    >
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">{source}</pre>
    </BlockFrame>
  );
}

export function RawInlineView({ node, selected }: ReactNodeViewProps) {
  const t = useTranslations('editor');
  return (
    <NodeViewWrapper
      as="span"
      title={t('rawInlineTitle')}
      className={cn(
        'rounded border border-dashed border-border bg-muted px-1 font-mono text-[0.85em] text-muted-foreground',
        selected && 'border-ring',
      )}
    >
      {String(node.attrs.source ?? '')}
    </NodeViewWrapper>
  );
}
