'use client';

import Link from 'next/link';
import { useActionState, useEffect, useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { createPageAction, renderPreviewAction, updatePageAction } from './actions';
import type { PageFormState } from './actions';
import { useEditLease } from './use-edit-lease';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Field, Input, Label, Select } from '@/components/ui/field';
import { PageBody } from '@/components/page-body';
import { lastSegment, slugifySegment } from '@/lib/pages/paths';
import { generateSegment } from '@/lib/pages/slug';
import { cn, formatDateTime } from '@/lib/utils';

export interface PageFormParent {
  id: string;
  title: string;
  path: string;
  /** How deep the page sits in the tree, for indenting the picker. */
  depth: number;
}

export interface PageFormProps {
  mode: 'create' | 'edit';
  /** The space the page is created in; pages never change space. */
  spaceKey: string;
  parents: PageFormParent[];
  initial: {
    pageId?: string;
    baseContentHash?: string;
    title: string;
    /** The page's current last path segment when editing; empty when creating. */
    segment: string;
    parentId: string;
    kind: 'technical' | 'human';
    summary: string;
    body: string;
  };
  cancelHref: string;
}

const initialState: PageFormState = {};

/**
 * The page editor.
 *
 * Markdown in a textarea with a preview, deliberately — a rich-text editor
 * would put a second representation of the document between the author and
 * what is stored, and the stored form is what agents read and what exports
 * carry.
 */
/**
 * The path a page will get, as the server will build it: the parent's path, then
 * the typed segment or, failing that, the fallback. On create the fallback is
 * the segment generated from the title; on edit it is the page's current
 * segment. `invalid` when a typed segment has nothing a segment can be made of,
 * `null` when there is nothing to show yet. A taken generated path is numbered
 * by the server, which the preview does not try to predict.
 */
function previewPath(
  parents: PageFormParent[],
  parentId: string,
  segment: string,
  fallback: string,
): string | 'invalid' | null {
  const parent = parents.find((candidate) => candidate.id === parentId);
  let last: string;
  if (segment.trim() !== '') {
    last = slugifySegment(segment);
    if (last === '') return 'invalid';
  } else {
    last = fallback;
  }
  if (last === '') return null;
  return `${parent ? parent.path : ''}/${last}`;
}

export function PageForm({ mode, spaceKey, parents, initial, cancelHref }: PageFormProps) {
  const t = useTranslations('editor');
  const tc = useTranslations('common');
  const format = useFormatter();

  const action = mode === 'create' ? createPageAction : updatePageAction;
  const [state, formAction, pending] = useActionState(action, initialState);

  // Editing a page means holding it. The lease is taken when this form mounts
  // and returned when it goes away, so two people cannot both be told they are
  // editing the same page.
  const lease = useEditLease(mode === 'edit' ? initial.pageId : undefined);
  const blocked = mode === 'edit' && (lease.status === 'conflict' || lease.status === 'lost');

  const [body, setBody] = useState(initial.body);
  const [title, setTitle] = useState(initial.title);
  const [parentId, setParentId] = useState(initial.parentId);
  const [segment, setSegment] = useState(initial.segment);
  // An edit with the segment cleared keeps the page's current segment, which is
  // what the server does too; a new page falls back to its title.
  const generatedSegment = title.trim() === '' ? '' : generateSegment(title);
  const resultingPath = previewPath(
    parents,
    parentId,
    segment,
    mode === 'edit' ? initial.segment : generatedSegment,
  );
  const [showPreview, setShowPreview] = useState(false);
  const [preview, setPreview] = useState('');
  const [rendering, startRendering] = useTransition();

  useEffect(() => {
    if (!showPreview) return;
    startRendering(async () => {
      setPreview(await renderPreviewAction(body));
    });
  }, [showPreview, body]);

  return (
    <div className="grid gap-5">
      {state.error === 'forbidden' ? <Alert tone="error">{t('errorForbidden')}</Alert> : null}
      {state.error === 'conflict' ? (
        <Alert tone="error">{state.message ?? t('errorConflict')}</Alert>
      ) : null}
      {state.error === 'stale_base' ? <Alert tone="error">{t('errorStaleBase')}</Alert> : null}
      {state.error === 'validation' ? (
        <Alert tone="error">{state.message ?? t('errorValidation')}</Alert>
      ) : null}
      {state.error === 'not_found' ? <Alert tone="error">{t('errorNotFound')}</Alert> : null}
      {state.error === 'generic' ? <Alert tone="error">{t('errorGeneric')}</Alert> : null}

      {mode === 'edit' && lease.status === 'acquiring' ? (
        <Alert>{t('claimAcquiring')}</Alert>
      ) : null}
      {mode === 'edit' && lease.status === 'held' ? (
        <Alert tone="success">{t('claimHeld')}</Alert>
      ) : null}
      {mode === 'edit' && lease.status === 'conflict' ? (
        <Alert tone="error">
          {t('claimHeldByOther', {
            name: lease.heldBy ?? t('claimSomeoneElse'),
            since: formatDateTime(format, lease.heldSince) ?? '—',
          })}{' '}
          <Link href={cancelHref} className="underline underline-offset-2">
            {t('claimReadOnly')}
          </Link>
        </Alert>
      ) : null}
      {mode === 'edit' && lease.status === 'lost' ? (
        <Alert tone="error">{t('claimLost')}</Alert>
      ) : null}
      {mode === 'edit' && lease.status === 'error' ? (
        <Alert tone="error">{t('claimError')}</Alert>
      ) : null}

      <form action={formAction} className="grid gap-5">
        {mode === 'create' ? <input type="hidden" name="spaceKey" value={spaceKey} /> : null}
        {initial.pageId ? <input type="hidden" name="pageId" value={initial.pageId} /> : null}
        {initial.baseContentHash ? (
          <input type="hidden" name="baseContentHash" value={initial.baseContentHash} />
        ) : null}
        {/* Carries the lease into the save. Empty when the browser could not
            take one, in which case the action takes one of its own. */}
        {mode === 'edit' ? <input type="hidden" name="claimId" value={lease.claimId ?? ''} /> : null}

        <Field label={t('title')} htmlFor="title">
          <Input
            id="title"
            name="title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
            maxLength={300}
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={t('parent')} htmlFor="parentId" hint={t('parentHint')}>
            <Select
              id="parentId"
              name="parentId"
              value={parentId}
              onChange={(event) => setParentId(event.target.value)}
            >
              <option value="">{t('parentNone')}</option>
              {parents.map((parent) => (
                <option key={parent.id} value={parent.id}>
                  {/* Indented by depth, so the picker reads as the tree it is. */}
                  {`${'\u00a0\u00a0'.repeat(parent.depth)}${parent.title} (${lastSegment(parent.path)})`}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('kind')} htmlFor="kind" hint={t('kindHint')}>
            <Select id="kind" name="kind" defaultValue={initial.kind}>
              <option value="technical">{t('kindTechnical')}</option>
              <option value="human">{t('kindHuman')}</option>
            </Select>
          </Field>
        </div>

        <Field label={t('segment')} htmlFor="segment" hint={t('segmentHint')}>
          <Input
            id="segment"
            name="segment"
            value={segment}
            onChange={(event) => setSegment(event.target.value)}
            maxLength={80}
            placeholder={generatedSegment || 'auth'}
            className="font-mono text-xs"
          />
        </Field>

        <p className="text-xs text-muted-foreground" aria-live="polite">
          {resultingPath === 'invalid'
            ? t('resultingPathUnknown')
            : resultingPath === null
              ? null
              : t.rich('resultingPath', {
                  space: spaceKey,
                  path: resultingPath,
                  code: (chunks) => <code className="font-mono text-foreground">{chunks}</code>,
                })}
        </p>

        <Field label={t('summary')} htmlFor="summary" hint={t('summaryHint')}>
          <Input id="summary" name="summary" defaultValue={initial.summary} maxLength={2000} />
        </Field>

        <div className="grid gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor="body">{t('body')}</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={showPreview}
              onClick={() => setShowPreview((value) => !value)}
            >
              {showPreview ? t('hidePreview') : t('showPreview')}
            </Button>
          </div>

          <textarea
            id="body"
            name="body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            spellCheck={false}
            className={cn(
              'min-h-96 w-full rounded-(--radius-base) border border-input bg-card p-3',
              'font-mono text-sm leading-relaxed',
            )}
          />
          <p className="text-xs text-muted-foreground">{t('bodyHint')}</p>

          {showPreview ? (
            <div className="rounded-(--radius-base) border border-border bg-card p-4">
              {rendering && preview === '' ? (
                <p className="text-sm text-muted-foreground">{tc('loading')}</p>
              ) : (
                <PageBody html={preview} />
              )}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending || blocked}>
            {pending ? tc('loading') : mode === 'create' ? t('create') : t('save')}
          </Button>
          <Link
            href={cancelHref}
            className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {tc('cancel')}
          </Link>
        </div>
      </form>
    </div>
  );
}
