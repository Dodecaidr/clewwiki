'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';

import { saveDiscussionSettingsAction } from '@/app/spaces/discussion-actions';
import type { DiscussionFormState } from '@/app/spaces/discussion-actions';
import type { SpaceFormPage } from './space-form';
import { Alert } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';

const initialState: DiscussionFormState = {};

/**
 * How long this space's discussions live, and where its decisions are filed.
 *
 * Both windows are on one form because they are one policy: how long a question
 * may stay unanswered, and how long the answered ones are kept before the
 * conversation is thrown away. The decision pages themselves are never affected
 * by either number, and the form says so.
 */
export function DiscussionSettingsForm({
  spaceKey,
  pages,
  initial,
}: {
  spaceKey: string;
  pages: SpaceFormPage[];
  initial: { idleDays: number; retentionDays: number; decisionsPageId: string };
}) {
  const t = useTranslations('discussions');
  const tc = useTranslations('common');
  const [state, action, pending] = useActionState(saveDiscussionSettingsAction, initialState);

  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="spaceKey" value={spaceKey} />

      {state.saved ? <Alert tone="success">{t('settingsSaved')}</Alert> : null}
      {state.error === 'forbidden' ? <Alert tone="error">{t('adminOnly')}</Alert> : null}
      {state.error && state.error !== 'forbidden' ? (
        <Alert tone="error">{state.message ?? t('errorGeneric')}</Alert>
      ) : null}

      <Field label={t('idleDaysLabel')} htmlFor="discussion-idle-days" hint={t('idleDaysHint')}>
        <Input
          id="discussion-idle-days"
          name="idleDays"
          type="number"
          min={1}
          max={365}
          defaultValue={initial.idleDays}
        />
      </Field>

      <Field
        label={t('retentionDaysLabel')}
        htmlFor="discussion-retention-days"
        hint={t('retentionDaysHint')}
      >
        <Input
          id="discussion-retention-days"
          name="retentionDays"
          type="number"
          min={1}
          max={365}
          defaultValue={initial.retentionDays}
        />
      </Field>

      <Field
        label={t('decisionsPageLabel')}
        htmlFor="discussion-decisions-page"
        hint={t('decisionsPageHint')}
      >
        <Select
          id="discussion-decisions-page"
          name="decisionsPageId"
          defaultValue={initial.decisionsPageId}
        >
          <option value="">{t('decisionsPageDefault')}</option>
          {pages.map((page) => (
            <option key={page.id} value={page.id}>
              {`${'  '.repeat(page.depth)}${page.title}`}
            </option>
          ))}
        </Select>
      </Field>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? tc('loading') : t('settingsSave')}
        </Button>
      </div>
    </form>
  );
}
