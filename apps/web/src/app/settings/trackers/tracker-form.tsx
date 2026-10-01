'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';

import { addTrackerAction } from './actions';
import type { TrackerFormState } from './actions';
import { Alert } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';

const initialState: TrackerFormState = {};

export function TrackerForm() {
  const t = useTranslations('trackers');
  const tc = useTranslations('common');
  const [state, action, pending] = useActionState(addTrackerAction, initialState);
  const [kind, setKind] = useState('youtrack');

  return (
    <form action={action} className="grid gap-4">
      {state.error ? <Alert tone="error">{t(`error_${state.error}` as 'error_generic')}</Alert> : null}
      {state.ok ? <Alert tone="info">{t('added')}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('kind')} htmlFor="tracker-kind">
          <Select id="tracker-kind" name="kind" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="youtrack">YouTrack</option>
            <option value="jira">Jira</option>
            <option value="other">{t('kindOther')}</option>
          </Select>
        </Field>
        <Field label={t('name')} htmlFor="tracker-name">
          <Input id="tracker-name" name="name" required maxLength={60} placeholder="YouTrack" />
        </Field>
        <Field label={t('baseUrl')} htmlFor="tracker-url" hint={t('baseUrlHint')}>
          <Input id="tracker-url" name="baseUrl" type="url" required placeholder="https://youtrack.example.com" />
        </Field>
        <Field label={t('projects')} htmlFor="tracker-projects" hint={t('projectsHint')}>
          <Input id="tracker-projects" name="projects" required placeholder="APP, MAC" />
        </Field>
        {kind === 'other' ? (
          <Field label={t('urlTemplate')} htmlFor="tracker-template" hint={t('urlTemplateHint')}>
            <Input
              id="tracker-template"
              name="urlTemplate"
              required
              placeholder="https://gitlab.example.com/group/{project}/-/issues/{number}"
            />
          </Field>
        ) : (
          <Field label={t('tokenEnv')} htmlFor="tracker-token" hint={t('tokenEnvHint')}>
            <Input id="tracker-token" name="tokenEnv" placeholder="CLEWWIKI_TRACKER_TOKEN_YOUTRACK" />
          </Field>
        )}
      </div>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? tc('loading') : t('add')}
        </Button>
      </div>
    </form>
  );
}
