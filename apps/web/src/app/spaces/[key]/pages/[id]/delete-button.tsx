'use client';

import { useActionState } from 'react';

import { deletePageAction } from '@/app/pages/actions';
import type { PageFormState } from '@/app/pages/actions';
import { Button } from '@/components/ui/button';

const initialState: PageFormState = {};

/**
 * Deletion is a form post, not a link: a GET that removes a page would be
 * followed by any link prefetcher or crawler that saw it.
 */
export function DeletePageButton({
  pageId,
  label,
  confirm,
}: {
  pageId: string;
  label: string;
  confirm: string;
}) {
  const [state, action, pending] = useActionState(deletePageAction, initialState);

  return (
    <form
      className="grid justify-items-start gap-2"
      action={action}
      onSubmit={(event) => {
        if (!window.confirm(confirm)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="pageId" value={pageId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {label}
      </Button>
      {state.error && state.message ? (
        <p role="alert" className="text-xs text-destructive">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
