'use client';

import { checkMermaidSource, MERMAID_TEMPLATES } from '@clewwiki/content/mermaid';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { isAllowedLinkTarget } from './commands';
import { EditorDialog } from './editor-dialog';
import { MermaidPreview } from './mermaid-preview';
import { isAllowedImageSource } from './schema';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';

/* ------------------------------------------------------------------ */
/* Mermaid                                                             */
/* ------------------------------------------------------------------ */

/**
 * Diagram source beside a live drawing of it, with a template per diagram
 * type to start from. The source is what gets stored: the template picker only
 * fills the text area.
 */
export function MermaidDialog({
  open,
  initialSource,
  mode,
  onCancel,
  onSave,
}: {
  open: boolean;
  initialSource: string | null;
  mode: 'insert' | 'edit';
  onCancel: () => void;
  onSave: (source: string) => void;
}) {
  if (!open) return null;
  return <MermaidDialogBody initialSource={initialSource} mode={mode} onCancel={onCancel} onSave={onSave} />;
}

function MermaidDialogBody({
  initialSource,
  mode,
  onCancel,
  onSave,
}: {
  initialSource: string | null;
  mode: 'insert' | 'edit';
  onCancel: () => void;
  onSave: (source: string) => void;
}) {
  const t = useTranslations('editor');
  const [source, setSource] = useState(initialSource ?? MERMAID_TEMPLATES[0]?.source ?? '');
  const [template, setTemplate] = useState(initialSource === null ? (MERMAID_TEMPLATES[0]?.id ?? '') : '');
  const issues = checkMermaidSource(source);

  const chooseTemplate = (id: string) => {
    const chosen = MERMAID_TEMPLATES.find((candidate) => candidate.id === id);
    if (!chosen) return;
    const untouched =
      source.trim() === '' || MERMAID_TEMPLATES.some((candidate) => candidate.source === source);
    if (!untouched && !window.confirm(t('mermaidReplaceConfirm'))) return;
    setTemplate(id);
    setSource(chosen.source);
  };

  return (
    <EditorDialog
      open
      size="lg"
      onClose={onCancel}
      title={mode === 'insert' ? t('mermaidInsertTitle') : t('mermaidEditTitle')}
      description={t('mermaidDescription')}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onCancel}>
            {t('dialogCancel')}
          </Button>
          <Button size="sm" disabled={issues.length > 0} onClick={() => onSave(source)}>
            {mode === 'insert' ? t('mermaidInsert') : t('mermaidSave')}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="grid content-start gap-3">
          <Field label={t('mermaidTemplate')} htmlFor="mermaid-template">
            <Select id="mermaid-template" value={template} onChange={(event) => chooseTemplate(event.target.value)}>
              <option value="" disabled>
                {t('mermaidTemplateChoose')}
              </option>
              {MERMAID_TEMPLATES.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {t(`mermaidTemplate_${candidate.id.replace('-', '_')}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('mermaidSource')} htmlFor="mermaid-source">
            <textarea
              id="mermaid-source"
              value={source}
              onChange={(event) => {
                setSource(event.target.value);
                setTemplate('');
              }}
              spellCheck={false}
              aria-invalid={issues.length > 0}
              className="min-h-80 w-full rounded-(--radius-base) border border-input bg-card p-3 font-mono text-xs leading-relaxed"
            />
          </Field>
          {issues.length > 0 ? (
            <p role="alert" className="text-sm text-destructive">
              {issues[0]?.message}
            </p>
          ) : null}
        </div>
        <div className="grid content-start gap-2">
          <p className="text-sm font-medium">{t('mermaidPreview')}</p>
          <div className="min-h-40 rounded-(--radius-base) border border-border p-3">
            <MermaidPreview
              source={source}
              labels={{
                rendering: t('mermaidRendering'),
                failed: (message) => t('mermaidFailed', { message }),
              }}
            />
          </div>
        </div>
      </div>
    </EditorDialog>
  );
}

/* ------------------------------------------------------------------ */
/* Link and image                                                      */
/* ------------------------------------------------------------------ */

export function LinkDialog({
  open,
  initialHref,
  onCancel,
  onSave,
}: {
  open: boolean;
  initialHref: string;
  onCancel: () => void;
  onSave: (href: string) => void;
}) {
  if (!open) return null;
  return <LinkDialogBody initialHref={initialHref} onCancel={onCancel} onSave={onSave} />;
}

function LinkDialogBody({
  initialHref,
  onCancel,
  onSave,
}: {
  initialHref: string;
  onCancel: () => void;
  onSave: (href: string) => void;
}) {
  const t = useTranslations('editor');
  const [href, setHref] = useState(initialHref);
  const valid = href.trim() === '' || isAllowedLinkTarget(href);

  const submit = () => {
    if (valid) onSave(href);
  };

  return (
    <EditorDialog
      open
      onClose={onCancel}
      title={t('linkTitle')}
      footer={
        <>
          {initialHref ? (
            <Button variant="ghost" size="sm" onClick={() => onSave('')}>
              {t('linkRemove')}
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={onCancel}>
            {t('dialogCancel')}
          </Button>
          <Button size="sm" disabled={!valid || href.trim() === ''} onClick={submit}>
            {t('linkApply')}
          </Button>
        </>
      }
    >
      <Field label={t('linkUrl')} htmlFor="link-href" hint={valid ? t('linkHint') : undefined}>
        <Input
          id="link-href"
          value={href}
          autoFocus
          placeholder="https://"
          aria-invalid={!valid}
          onChange={(event) => setHref(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
        />
      </Field>
      {!valid ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {t('linkInvalid')}
        </p>
      ) : null}
    </EditorDialog>
  );
}

export function ImageDialog({
  open,
  onCancel,
  onSave,
}: {
  open: boolean;
  onCancel: () => void;
  onSave: (image: { src: string; alt: string }) => void;
}) {
  if (!open) return null;
  return <ImageDialogBody onCancel={onCancel} onSave={onSave} />;
}

function ImageDialogBody({
  onCancel,
  onSave,
}: {
  onCancel: () => void;
  onSave: (image: { src: string; alt: string }) => void;
}) {
  const t = useTranslations('editor');
  const [src, setSrc] = useState('');
  const [alt, setAlt] = useState('');
  const valid = src.trim() === '' || isAllowedImageSource(src);
  const ready = src.trim() !== '' && valid;

  return (
    <EditorDialog
      open
      onClose={onCancel}
      title={t('imageTitle')}
      description={t('imageUploadsNote')}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onCancel}>
            {t('dialogCancel')}
          </Button>
          <Button size="sm" disabled={!ready} onClick={() => onSave({ src: src.trim(), alt: alt.trim() })}>
            {t('imageInsert')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label={t('imageUrl')} htmlFor="image-src">
          <Input
            id="image-src"
            value={src}
            autoFocus
            placeholder="https://"
            aria-invalid={!valid}
            onChange={(event) => setSrc(event.target.value)}
          />
        </Field>
        {!valid ? (
          <p role="alert" className="text-sm text-destructive">
            {t('imageInvalid')}
          </p>
        ) : null}
        <Field label={t('imageAlt')} htmlFor="image-alt" hint={t('imageAltHint')}>
          <Input id="image-alt" value={alt} onChange={(event) => setAlt(event.target.value)} />
        </Field>
      </div>
    </EditorDialog>
  );
}

/* ------------------------------------------------------------------ */
/* Verbatim Markdown                                                   */
/* ------------------------------------------------------------------ */

/** Edits a block the visual editor keeps as Markdown source. */
export function SourceDialog({
  open,
  initialSource,
  onCancel,
  onSave,
}: {
  open: boolean;
  initialSource: string;
  onCancel: () => void;
  onSave: (source: string) => void;
}) {
  if (!open) return null;
  return <SourceDialogBody initialSource={initialSource} onCancel={onCancel} onSave={onSave} />;
}

function SourceDialogBody({
  initialSource,
  onCancel,
  onSave,
}: {
  initialSource: string;
  onCancel: () => void;
  onSave: (source: string) => void;
}) {
  const t = useTranslations('editor');
  const [source, setSource] = useState(initialSource);
  return (
    <EditorDialog
      open
      size="lg"
      onClose={onCancel}
      title={t('rawBlockTitle')}
      description={t('rawBlockHint')}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onCancel}>
            {t('dialogCancel')}
          </Button>
          <Button size="sm" onClick={() => onSave(source)}>
            {t('rawBlockSave')}
          </Button>
        </>
      }
    >
      <Field label={t('rawBlockLabel')} htmlFor="raw-source">
        <textarea
          id="raw-source"
          value={source}
          onChange={(event) => setSource(event.target.value)}
          spellCheck={false}
          className="min-h-64 w-full rounded-(--radius-base) border border-input bg-card p-3 font-mono text-xs leading-relaxed"
        />
      </Field>
    </EditorDialog>
  );
}
