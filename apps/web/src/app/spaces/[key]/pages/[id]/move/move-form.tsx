'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';

import { movePageAction } from '@/app/pages/actions';
import type { MovePageFormState } from '@/app/pages/actions';
import { Button, buttonVariants } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/field';
import type { FlatTreeEntry } from '@/lib/spaces/tree';

const initialState: MovePageFormState = {};

/** The second step of a move: where in the chosen space the page goes. */
export function MovePageForm({
  pageId,
  spaceKey,
  spaceName,
  segment,
  parents,
  cancelHref,
}: {
  pageId: string;
  spaceKey: string;
  spaceName: string;
  segment: string;
  parents: FlatTreeEntry[];
  cancelHref: string;
}) {
  const t = useTranslations('movePage');
  const [state, action, pending] = useActionState(movePageAction, initialState);
  const [parentId, setParentId] = useState('');

  const parent = parents.find((entry) => entry.id === parentId);
  const resultingPath = `${parent ? parent.path : ''}/${segment}`;
  const names = state.names?.join(', ') ?? '';

  return (
    <form action={action} className="grid gap-5 border-t border-border pt-5">
      <input type="hidden" name="pageId" value={pageId} />
      <input type="hidden" name="spaceKey" value={spaceKey} />

      {state.error === 'conflict' && state.reason === 'claims' ? (
        <Alert tone="error">{t('refusedClaims', { names })}</Alert>
      ) : null}
      {state.error === 'conflict' && state.reason === 'paths' ? (
        <Alert tone="error">{t('refusedPaths', { space: spaceName, paths: names })}</Alert>
      ) : null}
      {state.error === 'conflict' && state.reason === 'designated' ? (
        <Alert tone="error">
          {t('refusedDesignated', {
            roles: (state.names ?? [])
              .map((role) =>
                role === 'home_page' ? t('roleHome') : role === 'rules_page' ? t('roleRules') : t('roleDecisions'),
              )
              .join(', '),
          })}
        </Alert>
      ) : null}
      {state.error === 'conflict' && state.reason === 'archived' ? (
        <Alert tone="error">{t('refusedArchived', { space: spaceName })}</Alert>
      ) : null}
      {state.error === 'validation' ? <Alert tone="error">{t('refusedTooDeep')}</Alert> : null}
      {state.error === 'not_found' ? <Alert tone="error">{t('refusedNotFound')}</Alert> : null}
      {state.error === 'forbidden' || state.error === 'generic' ? (
        <Alert tone="error">{t('refusedGeneric')}</Alert>
      ) : null}

      <Field label={t('parent')} htmlFor="parentId" hint={t('parentHint', { path: resultingPath, space: spaceName })}>
        <Select id="parentId" name="parentId" value={parentId} onChange={(event) => setParentId(event.target.value)}>
          <option value="">{t('parentNone')}</option>
          {parents.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {`${'  '.repeat(entry.depth)}${entry.title}`}
            </option>
          ))}
        </Select>
      </Field>

      <ul className="grid list-disc gap-1 pl-5 text-sm text-muted-foreground">
        <li>{t('noteKept')}</li>
        <li>{t('notePairs')}</li>
        <li>{t('noteAnchors')}</li>
        <li>{t('noteVisibility', { space: spaceName })}</li>
      </ul>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {t('submit', { space: spaceName })}
        </Button>
        <Link href={cancelHref} className={buttonVariants({ variant: 'outline' })}>
          {t('cancel')}
        </Link>
      </div>
    </form>
  );
}
