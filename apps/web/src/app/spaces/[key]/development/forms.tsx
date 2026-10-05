'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';

import {
  createReleaseAction,
  createStreamAction,
  ensureDocsPageAction,
  shipReleaseAction,
  syncStreamsAction,
  updateStreamAction,
} from './actions';
import type { DevelopmentFormState } from './actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/field';

const initial: DevelopmentFormState = {};

function Feedback({ state }: { state: DevelopmentFormState }) {
  const t = useTranslations('development');
  if (state.error) {
    return (
      <Alert tone="error">
        {state.message ?? t('errorGeneric')}
        {state.details && state.details.length > 0 ? ` ${state.details.join(', ')}` : ''}
      </Alert>
    );
  }
  if (state.message && state.message !== 'saved') return <Alert tone="info">{state.message}</Alert>;
  if (state.message === 'saved') return <Alert tone="info">{t('saved')}</Alert>;
  return null;
}

export function SyncButton({ spaceKey }: { spaceKey: string }) {
  const t = useTranslations('development');
  const [state, action, pending] = useActionState(syncStreamsAction, initial);
  return (
    <form action={action} className="grid gap-2">
      <input type="hidden" name="spaceKey" value={spaceKey} />
      <div>
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? t('syncing') : t('sync')}
        </Button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function NewStreamForm({ spaceKey, releases }: { spaceKey: string; releases: Array<{ id: string; name: string }> }) {
  const t = useTranslations('development');
  const [state, action, pending] = useActionState(createStreamAction, initial);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="spaceKey" value={spaceKey} />
      <Feedback state={state} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('streamTitle')} htmlFor="stream-title">
          <Input id="stream-title" name="title" required maxLength={120} />
        </Field>
        <Field label={t('branch')} htmlFor="stream-branch" hint={t('branchHint')}>
          <Input id="stream-branch" name="branch" maxLength={200} placeholder="feature/APP-42-login" />
        </Field>
        <Field label={t('release')} htmlFor="stream-release">
          <Select id="stream-release" name="releaseId" defaultValue="">
            <option value="">{t('noRelease')}</option>
            {releases.map((release) => (
              <option key={release.id} value={release.id}>
                {release.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label={t('goal')} htmlFor="stream-goal" hint={t('goalHint')}>
        <textarea
          id="stream-goal"
          name="goal"
          rows={3}
          maxLength={20000}
          className="w-full rounded-(--radius-base) border border-input bg-background px-3 py-2 text-sm"
        />
      </Field>
      <div>
        <Button type="submit" size="sm" disabled={pending}>
          {t('createStream')}
        </Button>
      </div>
    </form>
  );
}

export function NewReleaseForm({ spaceKey }: { spaceKey: string }) {
  const t = useTranslations('development');
  const [state, action, pending] = useActionState(createReleaseAction, initial);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="spaceKey" value={spaceKey} />
      <Feedback state={state} />
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('releaseName')} htmlFor="release-name">
          <Input id="release-name" name="name" required maxLength={40} placeholder="2.4.0" />
        </Field>
        <Field label={t('dueOn')} htmlFor="release-due">
          <Input id="release-due" name="dueOn" type="date" />
        </Field>
        <Button type="submit" size="sm" disabled={pending}>
          {t('createRelease')}
        </Button>
      </div>
    </form>
  );
}

export function ShipReleaseForm({ spaceKey, releaseId, missing }: { spaceKey: string; releaseId: string; missing: number }) {
  const t = useTranslations('development');
  const [state, action, pending] = useActionState(shipReleaseAction, initial);
  return (
    <form action={action} className="grid gap-2">
      <input type="hidden" name="spaceKey" value={spaceKey} />
      <input type="hidden" name="releaseId" value={releaseId} />
      <Feedback state={state} />
      <div className="flex flex-wrap items-center gap-3 text-xs">
        {missing > 0 ? (
          <label className="flex items-center gap-1.5 text-muted-foreground">
            <input type="checkbox" name="force" value="yes" />
            {t('shipAnyway', { count: missing })}
          </label>
        ) : null}
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {t('ship')}
        </Button>
      </div>
    </form>
  );
}

export function StreamEditForm({
  spaceKey,
  stream,
  releases,
}: {
  spaceKey: string;
  stream: { id: string; title: string; ref: string | null; state: string; goal: string; issueKeys: string[]; releaseId: string | null };
  releases: Array<{ id: string; name: string }>;
}) {
  const t = useTranslations('development');
  const [state, action, pending] = useActionState(updateStreamAction, initial);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="spaceKey" value={spaceKey} />
      <input type="hidden" name="streamId" value={stream.id} />
      <Feedback state={state} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={t('streamTitle')} htmlFor="edit-title">
          <Input id="edit-title" name="title" defaultValue={stream.title} required maxLength={120} />
        </Field>
        <Field label={t('branch')} htmlFor="edit-branch">
          <Input id="edit-branch" name="branch" defaultValue={stream.ref ?? ''} maxLength={200} />
        </Field>
        <Field label={t('state')} htmlFor="edit-state">
          <Select id="edit-state" name="state" defaultValue={stream.state}>
            {(['planned', 'active', 'review', 'merged', 'paused', 'dropped'] as const).map((value) => (
              <option key={value} value={value}>
                {t(`state_${value}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('release')} htmlFor="edit-release">
          <Select id="edit-release" name="releaseId" defaultValue={stream.releaseId ?? ''}>
            <option value="">{t('noRelease')}</option>
            {releases.map((release) => (
              <option key={release.id} value={release.id}>
                {release.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label={t('issueKeys')} htmlFor="edit-keys" hint={t('issueKeysHint')}>
        <Input id="edit-keys" name="issueKeys" defaultValue={stream.issueKeys.join(', ')} />
      </Field>
      <Field label={t('goal')} htmlFor="edit-goal" hint={t('goalHint')}>
        <textarea
          id="edit-goal"
          name="goal"
          rows={5}
          maxLength={20000}
          defaultValue={stream.goal}
          className="w-full rounded-(--radius-base) border border-input bg-background px-3 py-2 text-sm"
        />
      </Field>
      <div>
        <Button type="submit" size="sm" disabled={pending}>
          {t('save')}
        </Button>
      </div>
    </form>
  );
}

/** Files a stream under a release straight from the overview. */
export function QuickReleaseForm({
  spaceKey,
  streamId,
  releases,
}: {
  spaceKey: string;
  streamId: string;
  releases: Array<{ id: string; name: string }>;
}) {
  const t = useTranslations('development');
  const [, action, pending] = useActionState(updateStreamAction, initial);
  if (releases.length === 0) return null;
  return (
    <form action={action} className="flex items-center gap-1.5">
      <input type="hidden" name="spaceKey" value={spaceKey} />
      <input type="hidden" name="streamId" value={streamId} />
      <Select name="releaseId" defaultValue={releases[0]?.id} aria-label={t('release')} className="h-7 py-0 text-xs">
        {releases.map((release) => (
          <option key={release.id} value={release.id}>
            {release.name}
          </option>
        ))}
      </Select>
      <Button type="submit" variant="outline" size="sm" disabled={pending} className="whitespace-nowrap">
        {t('fileUnder')}
      </Button>
    </form>
  );
}

export function DocsPageButton({ spaceKey, streamId }: { spaceKey: string; streamId: string }) {
  const t = useTranslations('development');
  const [state, action, pending] = useActionState(ensureDocsPageAction, initial);
  return (
    <form action={action} className="grid gap-2">
      <input type="hidden" name="spaceKey" value={spaceKey} />
      <input type="hidden" name="streamId" value={streamId} />
      <Feedback state={state} />
      <div>
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {t('createDocs')}
        </Button>
      </div>
    </form>
  );
}
