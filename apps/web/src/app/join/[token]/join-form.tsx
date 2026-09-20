'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';

import { acceptInvitationAction } from './actions';
import type { JoinFormState } from './actions';
import { Alert } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';

const initialState: JoinFormState = {};

export function JoinForm({ token, email }: { token: string; email: string }) {
  const t = useTranslations('join');
  const tc = useTranslations('common');
  const [state, action, pending] = useActionState(acceptInvitationAction, initialState);

  return (
    <form action={action} className="grid gap-5">
      {state.error ? <Alert tone="error">{t(`error_${state.error}`)}</Alert> : null}
      <input type="hidden" name="token" value={token} />

      <Field label={t('email')} htmlFor="join-email" hint={t('emailHint')}>
        <Input id="join-email" type="email" value={email} readOnly autoComplete="username" />
      </Field>
      <Field label={t('name')} htmlFor="join-name" hint={t('nameHint')}>
        <Input id="join-name" name="name" required maxLength={100} autoComplete="name" />
      </Field>
      <Field label={t('password')} htmlFor="join-password" hint={t('passwordHint')}>
        <Input
          id="join-password"
          name="password"
          type="password"
          required
          minLength={12}
          maxLength={256}
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
