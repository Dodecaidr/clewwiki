'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';

import { createOrganizationAction } from './actions';
import type { CreateOrgState } from './actions';
import { Alert } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';

const initialState: CreateOrgState = {};

/** Suggests an address from the name until the reader edits the address themselves. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function CreateOrgForm() {
  const t = useTranslations('orgs');
  const tc = useTranslations('common');
  const [state, action, pending] = useActionState(createOrganizationAction, initialState);
  const [slug, setSlug] = useState('');
  const [edited, setEdited] = useState(false);

  return (
    <form action={action} className="grid gap-4">
      {state.error ? <Alert tone="error">{t(`error_${state.error}`)}</Alert> : null}
      <Field label={t('name')} htmlFor="org-name">
        <Input
          id="org-name"
          name="name"
          required
          maxLength={80}
          onChange={(event) => {
            if (!edited) setSlug(slugify(event.target.value));
          }}
        />
      </Field>
      <Field label={t('slug')} htmlFor="org-slug" hint={t('slugHint')}>
        <Input
          id="org-slug"
          name="slug"
          required
          maxLength={40}
          pattern="[a-z0-9][a-z0-9\-]{1,39}"
          value={slug}
          onChange={(event) => {
            setEdited(true);
            setSlug(event.target.value);
          }}
        />
      </Field>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? tc('loading') : t('create')}
        </Button>
      </div>
    </form>
  );
}
