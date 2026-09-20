import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { listInvitations, listMembers } from '@/lib/members/service';
import { getSessionContext } from '@/lib/session';
import { formatDateTime } from '@/lib/utils';

import { InviteForm, RemoveMemberButton, RevokeInvitationButton, RoleForm } from './member-forms';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('members');
  return { title: t('title') };
}

export default async function MembersPage() {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }

  const t = await getTranslations('members');
  const format = await getFormatter();
  const isAdmin = session.role === 'admin';
  const [members, invitations] = await Promise.all([
    listMembers(session.workspace.id),
    isAdmin ? listInvitations(session.workspace.id) : Promise.resolve([]),
  ]);

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      {isAdmin ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('inviteHeading')}</CardTitle>
            <CardDescription>{t('inviteIntro')}</CardDescription>
          </CardHeader>
          <CardBody className="grid gap-5">
            <InviteForm />
            {invitations.length > 0 ? (
              <div className="grid gap-2">
                <h3 className="text-sm font-medium">{t('pendingHeading')}</h3>
                <ul className="grid gap-2">
                  {invitations.map((invitation) => (
                    <li
                      key={invitation.id}
                      className="flex flex-wrap items-center gap-3 rounded-(--radius-base) border border-border px-3 py-2 text-sm"
                    >
                      <span className="font-mono text-xs">{invitation.email}</span>
                      <span className="text-xs text-muted-foreground">
                        {t(`role_${invitation.role}`)} ·{' '}
                        {invitation.state === 'expired'
                          ? t('expired')
                          : t('expiresAt', { when: formatDateTime(format, invitation.expiresAt) ?? '' })}
                      </span>
                      <span className="ml-auto">
                        <RevokeInvitationButton invitationId={invitation.id} email={invitation.email} />
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('membersHeading', { count: members.length })}</CardTitle>
        </CardHeader>
        <CardBody>
          <ul className="grid gap-3">
            {members.map((member) => (
              <li
                key={member.userId}
                className="flex flex-wrap items-start gap-3 rounded-(--radius-base) border border-border px-3 py-2"
              >
                <div className="grid gap-0.5">
                  <span className="text-sm font-medium">
                    {member.name}
                    {member.userId === session.userId ? (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">{t('you')}</span>
                    ) : null}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">{member.email}</span>
                  <span className="text-xs text-muted-foreground">
                    {t('joinedAt', { when: formatDateTime(format, member.joinedAt) ?? '' })}
                  </span>
                </div>
                <div className="ml-auto flex flex-wrap items-start gap-3">
                  {isAdmin ? (
                    <>
                      <RoleForm userId={member.userId} name={member.name} role={member.role} />
                      {member.userId === session.userId ? null : (
                        <RemoveMemberButton userId={member.userId} name={member.name} />
                      )}
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">{t(`role_${member.role}`)}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
