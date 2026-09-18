'use client';

import { useActionState, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import {
  deleteDiscussionAction,
  postDiscussionMessageAction,
  resolveDiscussionAction,
} from '@/app/spaces/discussion-actions';
import type { DiscussionFormState } from '@/app/spaces/discussion-actions';
import { Alert } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';

const initialState: DiscussionFormState = {};

function textareaClass(): string {
  return 'w-full rounded-(--radius-base) border border-input bg-card px-3 py-2 text-sm';
}

function errorText(state: DiscussionFormState, fallback: string): string | null {
  if (!state.error) return null;
  return state.message ?? fallback;
}

/** The compose box under an open thread. */
export function ComposeMessage({ discussionId }: { discussionId: string }) {
  const t = useTranslations('discussions');
  const tc = useTranslations('common');
  const [state, action, pending] = useActionState(postDiscussionMessageAction, initialState);

  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="discussionId" value={discussionId} />
      {state.error === 'rate_limited' ? (
        <Alert tone="error">{t('errorRateLimited')}</Alert>
      ) : state.error ? (
        <Alert tone="error">{errorText(state, t('errorGeneric'))}</Alert>
      ) : null}
      <Field label={t('replyLabel')} htmlFor="discussion-reply" hint={t('replyHint')}>
        <textarea
          id="discussion-reply"
          name="body"
          required
          rows={5}
          className={textareaClass()}
          defaultValue=""
        />
      </Field>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? tc('loading') : t('replyButton')}
        </Button>
      </div>
    </form>
  );
}

/**
 * The resolve form, which is also the only place the interface explains what
 * resolving does: it writes a page and lets the conversation be cleaned up.
 *
 * The page the resolution will create is named before the button is pressed —
 * its title is the thread's, and it lands under the space's decisions page —
 * because "resolve" is otherwise an irreversible verb with an invisible effect.
 */
export function ResolveForm({
  discussionId,
  title,
  decisionsParentTitle,
}: {
  discussionId: string;
  title: string;
  decisionsParentTitle: string;
}) {
  const t = useTranslations('discussions');
  const tc = useTranslations('common');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(resolveDiscussionAction, initialState);

  if (!open) {
    return (
      <div className="grid justify-items-start gap-2">
        <Button type="button" onClick={() => setOpen(true)}>
          {t('resolveButton')}
        </Button>
        <p className="text-xs text-muted-foreground">{t('resolveHint')}</p>
      </div>
    );
  }

  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="discussionId" value={discussionId} />
      {/* The decision page's headings are written in the language the person
          resolving is reading the interface in. */}
      <input type="hidden" name="locale" value={locale} />

      {state.error ? <Alert tone="error">{errorText(state, t('errorGeneric'))}</Alert> : null}

      <Alert tone="info">{t('resolvePreview', { title, parent: decisionsParentTitle })}</Alert>

      <Field label={t('decisionLabel')} htmlFor="decision" hint={t('decisionHint')}>
        <textarea id="decision" name="decision" required rows={4} className={textareaClass()} />
      </Field>
      <Field label={t('contextLabel')} htmlFor="decision-context" hint={t('contextHint')}>
        <textarea id="decision-context" name="context" rows={3} className={textareaClass()} />
      </Field>
      <Field label={t('optionsLabel')} htmlFor="decision-options" hint={t('optionsHint')}>
        <textarea id="decision-options" name="options" rows={3} className={textareaClass()} />
      </Field>
      <Field
        label={t('consequencesLabel')}
        htmlFor="decision-consequences"
        hint={t('consequencesHint')}
      >
        <textarea
          id="decision-consequences"
          name="consequences"
          rows={3}
          className={textareaClass()}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? tc('loading') : t('resolveSubmit')}
        </Button>
        <Button type="button" variant="outline" onClick={() => setOpen(false)}>
          {tc('cancel')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Deleting a thread early. A form post rather than a link, so nothing that
 * follows links can perform it, and it is only rendered for somebody allowed
 * to: an administrator, or whoever opened the thread.
 */
export function DeleteDiscussionButton({ discussionId }: { discussionId: string }) {
  const t = useTranslations('discussions');
  const [state, action, pending] = useActionState(deleteDiscussionAction, initialState);
  const confirmText = t('deleteConfirm');

  return (
    <form
      className="grid justify-items-start gap-2"
      action={action}
      onSubmit={(event) => {
        if (!window.confirm(confirmText)) event.preventDefault();
      }}
    >
      <input type="hidden" name="discussionId" value={discussionId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {t('deleteButton')}
      </Button>
      {state.error ? (
        <p role="alert" className="text-xs text-destructive">
          {errorText(state, t('errorGeneric'))}
        </p>
      ) : null}
    </form>
  );
}
