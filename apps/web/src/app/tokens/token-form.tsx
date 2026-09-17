'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';

import { createAgentTokenAction } from './actions';
import type { TokenFormState } from './actions';
import { Alert } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input, Label, Select } from '@/components/ui/field';
import { AGENT_SCOPES, DEFAULT_AGENT_SCOPES } from '@/lib/scopes';

const initialState: TokenFormState = {};

const EXPIRY_CHOICES = [7, 30, 90, 365] as const;

export function TokenForm() {
  const t = useTranslations('tokens');
  const tc = useTranslations('common');
  const [state, action, pending] = useActionState(createAgentTokenAction, initialState);

  return (
    <div className="grid gap-5">
      {state.issuedToken ? (
        <Alert tone="success" className="grid gap-2">
          <p className="font-medium">{t('secretHeading')}</p>
          <code className="block overflow-x-auto rounded-(--radius-base) bg-card px-3 py-2 font-mono text-xs">
            {state.issuedToken}
          </code>
          <p className="text-xs text-muted-foreground">{t('secretWarning')}</p>
        </Alert>
      ) : null}

      {state.error === 'forbidden' ? <Alert tone="error">{t('adminOnly')}</Alert> : null}
      {state.error === 'name' ? <Alert tone="error">{t('errorName')}</Alert> : null}
      {state.error === 'scopes' ? <Alert tone="error">{t('errorScopes')}</Alert> : null}
      {state.error === 'generic' ? <Alert tone="error">{t('errorGeneric')}</Alert> : null}

      <form action={action} className="grid gap-5">
        <Field label={t('name')} htmlFor="name" hint={t('nameHint')}>
          <Input id="name" name="name" required maxLength={100} />
        </Field>

        <Field label={t('expiry')} htmlFor="expiresInDays" hint={t('expiryHint')}>
          {/* A fixed lifetime is preselected; "no expiry" stays available as a
              deliberate choice at the end of the list, never the default. */}
          <Select id="expiresInDays" name="expiresInDays" defaultValue="30">
            {EXPIRY_CHOICES.map((days) => (
              <option key={days} value={days}>
                {t('expiryDays', { days })}
              </option>
            ))}
            <option value="0">{t('expiryNever')}</option>
          </Select>
        </Field>

        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">{t('scopes')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {AGENT_SCOPES.map((scope) => (
              <div key={scope} className="flex items-center gap-2">
                <input
                  id={`scope-${scope}`}
                  type="checkbox"
                  name="scopes"
                  value={scope}
                  defaultChecked={DEFAULT_AGENT_SCOPES.includes(scope)}
                  className="size-4"
                />
                <Label htmlFor={`scope-${scope}`} className="font-mono text-xs">
                  {scope}
                </Label>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t('scopesHint')}</p>
        </fieldset>

        <div>
          <Button type="submit" disabled={pending}>
            {pending ? tc('loading') : t('submit')}
          </Button>
        </div>
      </form>
    </div>
  );
}
