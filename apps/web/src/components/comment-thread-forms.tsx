'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';

import {
  deleteCommentAction,
  openCommentAction,
  replyCommentAction,
  resolveCommentAction,
} from '@/app/spaces/comment-actions';
import type { CommentFormState } from '@/app/spaces/comment-actions';
import { revealElement } from '@/components/commentable-body';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';

const initialState: CommentFormState = {};

const TEXTAREA =
  'w-full rounded-(--radius-base) border border-input bg-card px-3 py-2 text-sm';

function ErrorLine({ state }: { state: CommentFormState }) {
  const t = useTranslations('comments');
  if (!state.error) return null;
  return (
    <Alert tone="error">
      {state.error === 'rate_limited' ? t('errorRateLimited') : (state.message ?? t('errorGeneric'))}
    </Alert>
  );
}

/** Empties the form after a successful post; the new comment arrives with the page. */
function useResetOnSave(state: CommentFormState) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.savedAt) form.current?.reset();
  }, [state.savedAt]);
  return form;
}

export function ReplyForm({ threadId }: { threadId: string }) {
  const t = useTranslations('comments');
  const tc = useTranslations('common');
  const [state, action, pending] = useActionState(replyCommentAction, initialState);
  const form = useResetOnSave(state);

  return (
    <form ref={form} action={action} className="grid gap-2">
      <input type="hidden" name="threadId" value={threadId} />
      <ErrorLine state={state} />
      <label className="sr-only" htmlFor={`reply-${threadId}`}>
        {t('replyLabel')}
      </label>
      <textarea
        id={`reply-${threadId}`}
        name="body"
        required
        rows={2}
        placeholder={t('replyPlaceholder')}
        className={TEXTAREA}
      />
      <div>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? tc('loading') : t('reply')}
        </Button>
      </div>
    </form>
  );
}

export function ResolveButton({ threadId, resolved }: { threadId: string; resolved: boolean }) {
  const t = useTranslations('comments');
  const [state, action, pending] = useActionState(resolveCommentAction, initialState);
  return (
    <form action={action} className="grid gap-2">
      <input type="hidden" name="threadId" value={threadId} />
      <input type="hidden" name="resolved" value={resolved ? 'false' : 'true'} />
      <ErrorLine state={state} />
      <div>
        <Button type="submit" size="sm" variant={resolved ? 'outline' : 'primary'} disabled={pending}>
          {resolved ? t('reopen') : t('resolve')}
        </Button>
      </div>
    </form>
  );
}

export function DeleteCommentButton({ commentId }: { commentId: string }) {
  const t = useTranslations('comments');
  const [state, action, pending] = useActionState(deleteCommentAction, initialState);
  return (
    <form action={action} className="inline">
      <input type="hidden" name="commentId" value={commentId} />
      <button
        type="submit"
        disabled={pending}
        className="text-xs text-muted-foreground underline underline-offset-2 hover:text-destructive"
      >
        {t('delete')}
      </button>
      {state.error ? <span className="ml-2 text-xs text-destructive">{state.message ?? t('errorGeneric')}</span> : null}
    </form>
  );
}

/** A comment about the page as a whole — and the way to comment without a pointer. */
export function PageCommentForm({ pageId, version }: { pageId: string; version: number }) {
  const t = useTranslations('comments');
  const tc = useTranslations('common');
  const [state, action, pending] = useActionState(openCommentAction, initialState);
  const form = useResetOnSave(state);

  return (
    <form ref={form} action={action} className="grid gap-2">
      <input type="hidden" name="pageId" value={pageId} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="blockIndex" value="" />
      <ErrorLine state={state} />
      <label className="text-sm font-medium" htmlFor="page-comment">
        {t('pageCommentLabel')}
      </label>
      <textarea id="page-comment" name="body" required rows={3} className={TEXTAREA} />
      <p className="text-xs text-muted-foreground">{t('pageCommentHint')}</p>
      <div>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? tc('loading') : t('submit')}
        </Button>
      </div>
    </form>
  );
}

/** Scrolls to the paragraph a thread is about. */
export function JumpToBlock({ blockIndex, label }: { blockIndex: number; label: string }) {
  return (
    <button
      type="button"
      onClick={() =>
        revealElement(document.querySelector<HTMLElement>(`[data-block="${blockIndex}"]`))
      }
      className="text-xs underline underline-offset-2"
    >
      {label}
    </button>
  );
}
