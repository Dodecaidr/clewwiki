'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';

import { reviewPageAction } from '@/app/spaces/review-actions';
import type { ReviewFormState } from '@/app/spaces/review-actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Field } from '@/components/ui/field';

const initialState: ReviewFormState = {};

/** Errors the form has its own sentence for; anything else shows the server's message. */
const KNOWN_ERRORS = ['stale_base', 'nothing_pending', 'no_baseline', 'conflict'] as const;

/**
 * Accept or revert, with one optional note for both.
 *
 * Two submit buttons in one form rather than two forms: the note belongs to the
 * decision whichever it is, and the button pressed is the decision. The version
 * the reviewer is looking at travels with the form, so a page that changed
 * while they were reading is refused instead of decided blind.
 */
export function ReviewForm({
  pageId,
  version,
  canRevert,
  baselineVersion,
}: {
  pageId: string;
  version: number;
  canRevert: boolean;
  baselineVersion: number;
}) {
  const t = useTranslations('reviews');
  const tc = useTranslations('common');
  const [state, action, pending] = useActionState(reviewPageAction, initialState);

  const known = KNOWN_ERRORS.find((code) => code === state.error);
  const errorText = !state.error
    ? null
    : known && known !== 'conflict'
      ? t(`error.${known}`)
      : (state.message ?? t('error.generic'));

  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="pageId" value={pageId} />
      <input type="hidden" name="version" value={version} />
      {errorText ? <Alert tone="error">{errorText}</Alert> : null}
      <Field label={t('noteLabel')} htmlFor="review-note" hint={t('noteHint')}>
        <textarea
          id="review-note"
          name="note"
          rows={2}
          maxLength={2000}
          className="w-full rounded-(--radius-base) border border-input bg-card px-3 py-2 text-sm"
          defaultValue=""
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" name="decision" value="accept" disabled={pending}>
          {pending ? tc('loading') : t('accept')}
        </Button>
        {canRevert ? (
          <Button type="submit" name="decision" value="revert" variant="outline" disabled={pending}>
            {t('revertTo', { version: baselineVersion })}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {canRevert ? t('decisionHint', { version: baselineVersion }) : t('decisionHintCreated')}
      </p>
    </form>
  );
}
