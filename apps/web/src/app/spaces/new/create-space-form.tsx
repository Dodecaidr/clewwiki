'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';

import { createSpaceAction } from '../actions';
import type { SpaceFormState } from '../actions';
import { Alert } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input, Label } from '@/components/ui/field';
import { cn } from '@/lib/utils';

const initialState: SpaceFormState = {};

/** A key suggestion from the name: its letters and digits, uppercased, at most ten. */
function suggestKey(name: string): string {
  return name
    .normalize('NFKD')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10);
}

export function CreateSpaceForm() {
  const t = useTranslations('spaces');
  const tc = useTranslations('common');
  const [state, action, pending] = useActionState(createSpaceAction, initialState);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);

  const shownKey = keyEdited ? key : suggestKey(name);

  return (
    <form action={action} className="grid gap-5">
      {state.error === 'forbidden' ? <Alert tone="error">{t('adminOnly')}</Alert> : null}
      {state.error === 'conflict' ? <Alert tone="error">{t('errorKeyTaken')}</Alert> : null}
      {state.error === 'validation' ? (
        <Alert tone="error">
          {state.field === 'key' ? t('errorKey') : state.field === 'name' ? t('errorName') : t('errorValidation')}
        </Alert>
      ) : null}
      {state.error === 'generic' ? <Alert tone="error">{t('errorGeneric')}</Alert> : null}

      <Field label={t('name')} htmlFor="space-name" hint={t('nameHint')}>
        <Input
          id="space-name"
          name="name"
          required
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>

      <Field label={t('key')} htmlFor="space-key" hint={t('keyHint')}>
        <Input
          id="space-key"
          name="key"
          required
          minLength={2}
          maxLength={10}
          pattern="[A-Za-z0-9]{2,10}"
          autoComplete="off"
          className="font-mono uppercase"
          value={shownKey}
          onChange={(event) => {
            setKeyEdited(true);
            setKey(event.target.value.toUpperCase());
          }}
        />
      </Field>

      <Field label={t('icon')} htmlFor="space-icon" hint={t('iconHint')}>
        <Input id="space-icon" name="icon" maxLength={16} className="w-24" />
      </Field>

      <div className="grid gap-1.5">
        <Label htmlFor="space-description">{t('description')}</Label>
        <textarea
          id="space-description"
          name="description"
          maxLength={2000}
          className={cn(
            'min-h-28 w-full rounded-(--radius-base) border border-input bg-card p-3 text-sm',
          )}
        />
        <p className="text-xs text-muted-foreground">{t('descriptionHint')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? tc('loading') : t('create')}
        </Button>
        <Link href="/" className="text-sm text-muted-foreground hover:text-foreground hover:underline">
          {tc('cancel')}
        </Link>
      </div>
    </form>
  );
}
