'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';

import { changeRoleAction, inviteMemberAction, removeMemberAction, revokeInvitationAction } from './actions';
import type { MembersFormState } from './actions';
import { CopyBlock } from '@/components/copy-block';
import { Alert } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';

const initialState: MembersFormState = {};

function ErrorLine({ state }: { state: MembersFormState }) {
  const t = useTranslations('members');
  return state.error ? <Alert tone="error">{t(`error_${state.error}`)}</Alert> : null;
}

export function InviteForm() {
  const t = useTranslations('members');
  const tc = useTranslations('common');
  const [state, action, pending] = useActionState(inviteMemberAction, initialState);

  return (
    <div className="grid gap-4">
      {state.inviteLink ? (
        <Alert tone="info">
          <div className="grid gap-2">
            <p className="font-medium">{t('inviteReady', { email: state.invitedEmail ?? '' })}</p>
            <CopyBlock code={state.inviteLink} wrap />
            <p className="text-xs">{t('inviteReadyHint')}</p>
          </div>
        </Alert>
      ) : null}
      <ErrorLine state={state} />

      <form action={action} className="grid gap-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
        <Field label={t('email')} htmlFor="invite-email">
          <Input id="invite-email" name="email" type="email" required maxLength={254} autoComplete="off" />
        </Field>
        <Field label={t('role')} htmlFor="invite-role">
          <Select id="invite-role" name="role" defaultValue="editor">
            <option value="editor">{t('role_editor')}</option>
            <option value="admin">{t('role_admin')}</option>
          </Select>
        </Field>
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? tc('loading') : t('invite')}
          </Button>
        </div>
      </form>
    </div>
  );
}

export function RevokeInvitationButton({ invitationId, email }: { invitationId: string; email: string }) {
  const t = useTranslations('members');
  const [state, action, pending] = useActionState(revokeInvitationAction, initialState);
  return (
    <form action={action} className="grid gap-1">
      <input type="hidden" name="invitationId" value={invitationId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending} aria-label={`${t('revoke')} — ${email}`}>
        {t('revoke')}
      </Button>
      <ErrorLine state={state} />
    </form>
  );
}

export function RoleForm({ userId, name, role }: { userId: string; name: string; role: 'admin' | 'editor' }) {
  const t = useTranslations('members');
  const [state, action, pending] = useActionState(changeRoleAction, initialState);
  return (
    <form action={action} className="grid gap-1">
      <input type="hidden" name="userId" value={userId} />
      <div className="flex items-center gap-2">
        <Select name="role" defaultValue={role} aria-label={`${t('role')} — ${name}`} className="h-8 w-36 text-sm">
          <option value="editor">{t('role_editor')}</option>
          <option value="admin">{t('role_admin')}</option>
        </Select>
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {t('saveRole')}
        </Button>
      </div>
      <ErrorLine state={state} />
    </form>
  );
}

/** Two clicks, on purpose: removing a member deletes their account. */
export function RemoveMemberButton({ userId, name }: { userId: string; name: string }) {
  const t = useTranslations('members');
  const [state, action, pending] = useActionState(removeMemberAction, initialState);
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setArmed(true)} aria-label={`${t('remove')} — ${name}`}>
        {t('remove')}
      </Button>
    );
  }
  return (
    <form action={action} className="grid gap-1">
      <input type="hidden" name="userId" value={userId} />
      <p className="max-w-56 text-xs text-muted-foreground">{t('removeConfirm', { name })}</p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {t('removeYes')}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setArmed(false)}>
          {t('removeNo')}
        </Button>
      </div>
      <ErrorLine state={state} />
    </form>
  );
}
