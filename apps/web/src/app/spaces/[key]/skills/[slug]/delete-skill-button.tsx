'use client';

import { useActionState } from 'react';

import { deleteSkillAction } from '@/app/spaces/skill-actions';
import type { SkillFormState } from '@/app/spaces/skill-actions';
import { Button } from '@/components/ui/button';

const initialState: SkillFormState = {};

/**
 * Removing a skill is a form post, not a link: a GET that deleted something
 * would be followed by any link prefetcher or crawler that saw it.
 */
export function DeleteSkillButton({
  spaceKey,
  slug,
  label,
  confirm,
}: {
  spaceKey: string;
  slug: string;
  label: string;
  confirm: string;
}) {
  const [state, action, pending] = useActionState(deleteSkillAction, initialState);

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
      <input type="hidden" name="spaceKey" value={spaceKey} />
      <input type="hidden" name="slug" value={slug} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {label}
      </Button>
      {state.error && state.message ? (
        <p className="text-xs text-destructive">{state.message}</p>
      ) : null}
    </form>
  );
}
