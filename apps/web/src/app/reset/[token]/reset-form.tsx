'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';

import { completeResetAction } from './actions';
import type { ResetFormState } from './actions';
import { Alert } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';

const initialState: ResetFormState = {};

export function ResetForm({ token, email }: { token: string; email: string }) {
  const t = useTranslations('reset');
  const tc = useTranslations('common');
  const [state, action, pending] = useActionState(completeResetAction, initialState);

  return (
    <form action={action} className="grid gap-5">
      {state.error ? <Alert tone="error">{t(`error_${state.error}`)}</Alert> : null}
      <input type="hidden" name="token" value={token} />
      <Field label={t('email')} htmlFor="reset-email">
        <Input id="reset-email" type="email" value={email} readOnly autoComplete="username" />
      </Field>
      <Field label={t('password')} htmlFor="reset-password" hint={t('passwordHint')}>
        <Input
          id="reset-password"
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
