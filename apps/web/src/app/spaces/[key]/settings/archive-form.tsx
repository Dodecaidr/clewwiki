'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';

import { setSpaceArchivedAction } from '@/app/spaces/actions';
import type { SpaceFormState } from '@/app/spaces/actions';
import { Alert } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const initialState: SpaceFormState = {};

/** Archive, or bring back, behind a confirmation. */
export function ArchiveSpaceForm({ spaceKey, archived }: { spaceKey: string; archived: boolean }) {
  const t = useTranslations('spaces');
  const [state, action, pending] = useActionState(setSpaceArchivedAction, initialState);

  return (
    <form
      action={action}
      className="grid justify-items-start gap-3"
      onSubmit={(event) => {
        if (!archived && !window.confirm(t('archiveConfirm'))) event.preventDefault();
      }}
    >
      <input type="hidden" name="spaceKey" value={spaceKey} />
      <input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
      {state.error ? <Alert tone="error">{t('errorGeneric')}</Alert> : null}
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {archived ? t('unarchive') : t('archive')}
      </Button>
    </form>
  );
}
