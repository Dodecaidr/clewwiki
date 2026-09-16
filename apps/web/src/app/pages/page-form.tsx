'use client';

import Link from 'next/link';
import { useActionState, useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';

import { createPageAction, renderPreviewAction, updatePageAction } from './actions';
import type { PageFormState } from './actions';
import { useEditLease } from './use-edit-lease';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Field, Input, Label, Select } from '@/components/ui/field';
import { PageBody } from '@/components/page-body';
import { cn, formatDateTime } from '@/lib/utils';

export interface PageFormParent {
  id: string;
  title: string;
  path: string;
}

export interface PageFormProps {
  mode: 'create' | 'edit';
  parents: PageFormParent[];
  initial: {
    pageId?: string;
    baseContentHash?: string;
    title: string;
    path: string;
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
export function PageForm({ mode, parents, initial, cancelHref }: PageFormProps) {
  const t = useTranslations('editor');
  const tc = useTranslations('common');

  const action = mode === 'create' ? createPageAction : updatePageAction;
  const [state, formAction, pending] = useActionState(action, initialState);

  // Editing a page means holding it. The lease is taken when this form mounts
  // and returned when it goes away, so two people cannot both be told they are
  // editing the same page.
  const lease = useEditLease(mode === 'edit' ? initial.pageId : undefined);
  const blocked = mode === 'edit' && (lease.status === 'conflict' || lease.status === 'lost');

  const [body, setBody] = useState(initial.body);
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
            since: formatDateTime(lease.heldSince) ?? '—',
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
        {initial.pageId ? <input type="hidden" name="pageId" value={initial.pageId} /> : null}
        {initial.baseContentHash ? (
          <input type="hidden" name="baseContentHash" value={initial.baseContentHash} />
        ) : null}
        {/* Carries the lease into the save. Empty when the browser could not
            take one, in which case the action takes one of its own. */}
        {mode === 'edit' ? <input type="hidden" name="claimId" value={lease.claimId ?? ''} /> : null}

        <Field label={t('title')} htmlFor="title">
          <Input id="title" name="title" defaultValue={initial.title} required maxLength={300} />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={t('parent')} htmlFor="parentId" hint={t('parentHint')}>
            <Select id="parentId" name="parentId" defaultValue={initial.parentId}>
              <option value="">{t('parentNone')}</option>
              {parents.map((parent) => (
                <option key={parent.id} value={parent.id}>
                  {parent.path}
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

        <Field label={t('path')} htmlFor="path" hint={t('pathHint')}>
          <Input
            id="path"
            name="path"
            defaultValue={initial.path}
            maxLength={512}
            placeholder="/backend/auth"
            className="font-mono text-xs"
          />
        </Field>

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
