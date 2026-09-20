'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';

import { changeNameAction, changePasswordAction } from './actions';
import type { AccountFormState } from './actions';
import { Alert } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';

const initialState: AccountFormState = {};

function Outcome({ state, saved }: { state: AccountFormState; saved: string }) {
  const t = useTranslations('members');
  if (state.error) return <Alert tone="error">{t(`error_${state.error}`)}</Alert>;
  return state.saved ? <Alert tone="info">{saved}</Alert> : null;
}

export function NameForm({ name }: { name: string }) {
  const t = useTranslations('account');
  const tc = useTranslations('common');
  const [state, action, pending] = useActionState(changeNameAction, initialState);
  return (
    <form action={action} className="grid gap-4">
      <Outcome state={state} saved={t('nameSaved')} />
      <Field label={t('name')} htmlFor="account-name" hint={t('nameHint')}>
        <Input id="account-name" name="name" required maxLength={100} defaultValue={name} autoComplete="name" />
      </Field>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? tc('loading') : t('saveName')}
        </Button>
      </div>
    </form>
  );
}

export function PasswordForm({ email }: { email: string }) {
  const t = useTranslations('account');
  const tc = useTranslations('common');
  const [state, action, pending] = useActionState(changePasswordAction, initialState);
  return (
    <form action={action} className="grid gap-4">
      <Outcome state={state} saved={t('passwordSaved')} />
      {/* Present for password managers, which file the new password under it. */}
      <input type="text" name="username" value={email} readOnly hidden autoComplete="username" />
      <Field label={t('currentPassword')} htmlFor="account-current">
        <Input id="account-current" name="currentPassword" type="password" required autoComplete="current-password" />
      </Field>
      <Field label={t('newPassword')} htmlFor="account-new" hint={t('newPasswordHint')}>
        <Input
          id="account-new"
          name="newPassword"
          type="password"
          required
          minLength={12}
          maxLength={256}
          autoComplete="new-password"
        />
      </Field>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? tc('loading') : t('savePassword')}
        </Button>
      </div>
    </form>
  );
}
