'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';

import { saveSpaceAccessAction } from '@/app/spaces/actions';
import type { SpaceFormState } from '@/app/spaces/actions';
import { Alert } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const initialState: SpaceFormState = {};

export interface AccessPerson {
  userId: string;
  name: string;
  email: string;
  isAdmin: boolean;
}

/**
 * Who can see this space.
 *
 * One switch and one list. Workspace administrators are shown ticked and cannot
 * be unticked: they see every space whatever this form says, and a form that let
 * somebody untick them would be promising something the product does not do.
 */
export function SpaceAccessForm({
  spaceKey,
  restricted,
  people,
  memberIds,
}: {
  spaceKey: string;
  restricted: boolean;
  people: AccessPerson[];
  memberIds: string[];
}) {
  const t = useTranslations('spaces');
  const tc = useTranslations('common');
  const [state, action, pending] = useActionState(saveSpaceAccessAction, initialState);
  const [closed, setClosed] = useState(restricted);

  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="spaceKey" value={spaceKey} />

      {state.saved ? <Alert tone="success">{t('accessSaved')}</Alert> : null}
      {state.error === 'forbidden' ? <Alert tone="error">{t('accessAdminOnly')}</Alert> : null}
      {state.error && state.error !== 'forbidden' ? (
        <Alert tone="error">{state.message ?? t('accessError')}</Alert>
      ) : null}

      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          name="restricted"
          checked={closed}
          onChange={(event) => setClosed(event.target.checked)}
          className="mt-0.5 size-4"
        />
        <span className="grid gap-1">
          <span className="font-medium">{t('accessRestrictedLabel')}</span>
          <span className="text-xs text-muted-foreground">{t('accessRestrictedHint')}</span>
        </span>
      </label>

      <fieldset className="grid gap-2" disabled={!closed}>
        <legend className="text-sm font-medium">{t('accessMembersLegend')}</legend>
        <p className="text-xs text-muted-foreground">
          {closed ? t('accessMembersHint') : t('accessMembersHintOpen')}
        </p>
        <ul className="grid max-h-72 gap-1 overflow-y-auto rounded-(--radius-base) border border-border p-2">
          {people.map((person) => (
            <li key={person.userId}>
              <label className="flex items-center gap-3 rounded-(--radius-base) px-2 py-1 text-sm hover:bg-secondary">
                <input
                  type="checkbox"
                  name={person.isAdmin ? undefined : 'member'}
                  value={person.userId}
                  defaultChecked={person.isAdmin || memberIds.includes(person.userId)}
                  disabled={person.isAdmin}
                  className="size-4"
                />
                <span className="min-w-0 flex-1 truncate">
                  {person.name}{' '}
                  <span className="text-xs text-muted-foreground">{person.email}</span>
                </span>
                {person.isAdmin ? (
                  <span className="text-xs text-muted-foreground">{t('accessAdminAlways')}</span>
                ) : null}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <p className="text-xs text-muted-foreground">{t('accessTokensNote')}</p>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? tc('loading') : t('accessSave')}
        </Button>
      </div>
    </form>
  );
}
