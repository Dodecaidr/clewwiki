'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';

import { completeSetupAction } from './actions';
import type { SetupFormState } from './actions';
import { Alert } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';

const initialState: SetupFormState = {};

export function SetupForm() {
  const t = useTranslations('setup');
  const tc = useTranslations('common');
  const [state, action, pending] = useActionState(completeSetupAction, initialState);

  return (
    <form action={action} className="grid gap-5">
      {state.error === 'alreadyDone' ? <Alert tone="error">{t('errorAlreadyDone')}</Alert> : null}
      {state.error === 'generic' ? <Alert tone="error">{t('errorGeneric')}</Alert> : null}

      <Field label={t('workspaceName')} htmlFor="workspaceName" hint={t('workspaceNameHint')}>
        <Input
          id="workspaceName"
          name="workspaceName"
          required
          maxLength={100}
          autoComplete="organization"
          defaultValue="clewwiki"
        />
      </Field>

      <Field label={t('name')} htmlFor="name">
        <Input id="name" name="name" required maxLength={100} autoComplete="name" />
      </Field>

      <Field label={t('email')} htmlFor="email">
        <Input id="email" name="email" type="email" required autoComplete="username" />
      </Field>

      <Field label={t('password')} htmlFor="password" hint={t('passwordHint')}>
        <Input
          id="password"
          name="password"
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
        />
      </Field>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? tc('loading') : t('submit')}
        </Button>
      </div>
    </form>
  );
}
