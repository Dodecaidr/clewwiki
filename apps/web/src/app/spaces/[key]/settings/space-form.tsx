'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';

import { updateSpaceAction } from '@/app/spaces/actions';
import type { SpaceFormState } from '@/app/spaces/actions';
import { Alert } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input, Label, Select } from '@/components/ui/field';
import { cn } from '@/lib/utils';

const initialState: SpaceFormState = {};

export interface SpaceFormPage {
  id: string;
  title: string;
  depth: number;
}

export function SpaceDetailsForm({
  spaceKey,
  pages,
  initial,
}: {
  spaceKey: string;
  pages: SpaceFormPage[];
  initial: { name: string; description: string; icon: string; homePageId: string };
}) {
  const t = useTranslations('spaces');
  const tc = useTranslations('common');
  const [state, action, pending] = useActionState(updateSpaceAction, initialState);

  return (
    <form action={action} className="grid gap-5">
      <input type="hidden" name="spaceKey" value={spaceKey} />

      {state.saved ? <Alert tone="success">{t('saved')}</Alert> : null}
      {state.error === 'forbidden' ? <Alert tone="error">{t('adminOnly')}</Alert> : null}
      {state.error === 'validation' ? (
        <Alert tone="error">
          {state.field === 'name' ? t('errorName') : (state.message ?? t('errorValidation'))}
        </Alert>
      ) : null}
      {state.error && !['forbidden', 'validation'].includes(state.error) ? (
        <Alert tone="error">{t('errorGeneric')}</Alert>
      ) : null}

      <Field label={t('name')} htmlFor="space-name" hint={t('nameHint')}>
        <Input id="space-name" name="name" required maxLength={100} defaultValue={initial.name} />
      </Field>

      <Field label={t('icon')} htmlFor="space-icon" hint={t('iconHint')}>
        <Input id="space-icon" name="icon" maxLength={16} className="w-24" defaultValue={initial.icon} />
      </Field>

      <div className="grid gap-1.5">
        <Label htmlFor="space-description">{t('description')}</Label>
        <textarea
          id="space-description"
          name="description"
          maxLength={2000}
          defaultValue={initial.description}
          className={cn('min-h-28 w-full rounded-(--radius-base) border border-input bg-card p-3 text-sm')}
        />
        <p className="text-xs text-muted-foreground">{t('descriptionHint')}</p>
      </div>

      <Field label={t('homePage')} htmlFor="space-home" hint={t('homePageHint')}>
        <Select id="space-home" name="homePageId" defaultValue={initial.homePageId}>
          <option value="">{t('homePageNone')}</option>
          {pages.map((page) => (
            <option key={page.id} value={page.id}>
              {`${'  '.repeat(page.depth)}${page.title}`}
            </option>
          ))}
        </Select>
      </Field>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? tc('loading') : t('save')}
        </Button>
      </div>
    </form>
  );
}
