'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useTranslations } from 'next-intl';

import { openDiscussionAction } from '@/app/spaces/discussion-actions';
import type { DiscussionFormState } from '@/app/spaces/discussion-actions';
import { Alert } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';

const initialState: DiscussionFormState = {};

/**
 * The form that opens a thread.
 *
 * A plain textarea rather than the page editor. A message is a sentence or two
 * asked in a hurry, it is going to be deleted, and offering tables and diagrams
 * for it would suggest it is the place to write something worth keeping — which
 * is exactly what the decision page is for.
 */
export function OpenDiscussionForm({
  spaceKey,
  pageId,
  pageTitle,
  cancelHref,
}: {
  spaceKey: string;
  pageId: string | null;
  pageTitle: string | null;
  cancelHref: string;
}) {
  const t = useTranslations('discussions');
  const tc = useTranslations('common');
  const [state, action, pending] = useActionState(openDiscussionAction, initialState);

  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="spaceKey" value={spaceKey} />
      <input type="hidden" name="pageId" value={pageId ?? ''} />

      {state.error ? (
        <Alert tone="error">{state.message ?? t('errorGeneric')}</Alert>
      ) : null}

      {pageTitle ? (
        <p className="text-sm text-muted-foreground">{t('aboutPage', { title: pageTitle })}</p>
      ) : null}

      <Field label={t('titleLabel')} htmlFor="discussion-title" hint={t('titleHint')}>
        <Input id="discussion-title" name="title" maxLength={200} required autoFocus />
      </Field>

      <Field label={t('firstMessageLabel')} htmlFor="discussion-body" hint={t('firstMessageHint')}>
        <textarea
          id="discussion-body"
          name="body"
          required
          rows={8}
          className="w-full rounded-(--radius-base) border border-input bg-card px-3 py-2 text-sm"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? tc('loading') : t('openButton')}
        </Button>
        <Link href={cancelHref} className={buttonVariants({ variant: 'outline' })}>
          {tc('cancel')}
        </Link>
      </div>
    </form>
  );
}
