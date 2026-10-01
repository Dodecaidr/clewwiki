'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';

import { requestAccessAction } from './actions';
import type { RegisterFormState } from './actions';
import { Alert } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';

const initialState: RegisterFormState = {};

/** The full form for a stranger; only the message for a signed-in account. */
export function RegisterForm({ org, signedIn }: { org: string; signedIn: boolean }) {
  const t = useTranslations('register');
  const tc = useTranslations('common');
  const [state, action, pending] = useActionState(requestAccessAction, initialState);

  return (
    <form action={action} className="grid gap-5">
      {state.error ? <Alert tone="error">{t(`error_${state.error}`)}</Alert> : null}
      <input type="hidden" name="org" value={org} />
      {signedIn ? null : (
        <>
          <Field label={t('name')} htmlFor="reg-name">
            <Input id="reg-name" name="name" required maxLength={100} autoComplete="name" />
          </Field>
          <Field label={t('email')} htmlFor="reg-email">
            <Input id="reg-email" name="email" type="email" required maxLength={254} autoComplete="username" />
          </Field>
          <Field label={t('password')} htmlFor="reg-password" hint={t('passwordHint')}>
            <Input
              id="reg-password"
              name="password"
              type="password"
              required
              minLength={12}
              maxLength={256}
              autoComplete="new-password"
            />
          </Field>
        </>
      )}
      <Field label={t('message')} htmlFor="reg-message" hint={t('messageHint')}>
        <textarea
          id="reg-message"
          name="message"
          maxLength={1000}
          rows={3}
          className="w-full rounded-(--radius-base) border border-input bg-background px-3 py-2 text-sm"
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
