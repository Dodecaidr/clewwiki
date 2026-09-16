'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';

import { signInAction } from './actions';
import type { LoginFormState } from './actions';
import { Alert } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';

const initialState: LoginFormState = {};

export function LoginForm() {
  const t = useTranslations('login');
  const tc = useTranslations('common');
  const [state, action, pending] = useActionState(signInAction, initialState);

  return (
    <form action={action} className="grid gap-5">
      {state.error ? <Alert tone="error">{t('error')}</Alert> : null}

      <Field label={t('email')} htmlFor="email">
        <Input id="email" name="email" type="email" required autoComplete="username" />
      </Field>

      <Field label={t('password')} htmlFor="password">
        <Input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
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
