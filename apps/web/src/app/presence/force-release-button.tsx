'use client';

import { useActionState } from 'react';

import { forceReleaseClaimAction } from '../pages/claim-actions';
import type { ForceReleaseState } from '../pages/claim-actions';
import { Button } from '@/components/ui/button';

const initialState: ForceReleaseState = {};

/**
 * Takes a claim away from whoever holds it.
 *
 * A form post rather than a link, and behind a confirmation: it interrupts
 * somebody else's edit, and a GET that did this would be followed by any
 * prefetcher that saw it.
 */
export function ForceReleaseButton({
  claimId,
  label,
  confirm,
}: {
  claimId: string;
  label: string;
  confirm: string;
}) {
  const [, action, pending] = useActionState(forceReleaseClaimAction, initialState);

  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (!window.confirm(confirm)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="claimId" value={claimId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {label}
      </Button>
    </form>
  );
}
