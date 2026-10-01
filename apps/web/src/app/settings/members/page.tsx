import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/field';
import { getAuthBaseUrl } from '@/lib/env';
import { listInvitations, listMembers } from '@/lib/members/service';
import { listPendingAccessRequests, readRegistrationMode } from '@/lib/orgs/access';
import { getSessionContext } from '@/lib/session';
import { formatDateTime } from '@/lib/utils';

import { decideAccessAction, setRegistrationAction } from './access-actions';
import { InviteForm, RemoveMemberButton, ResetLinkButton, RevokeInvitationButton, RoleForm } from './member-forms';

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
  const [members, invitations, requests] = await Promise.all([
    listMembers(session.workspace.id),
    isAdmin ? listInvitations(session.workspace.id) : Promise.resolve([]),
    isAdmin ? listPendingAccessRequests(session.workspace.id) : Promise.resolve([]),
  ]);
  const registration = readRegistrationMode(session.workspace);
  const registerLink = `${getAuthBaseUrl().replace(/\/+$/, '')}/o/${session.workspace.slug}/register`;

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

      {isAdmin ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('accessHeading')}</CardTitle>
            <CardDescription>{t('accessIntro')}</CardDescription>
          </CardHeader>
          <CardBody className="grid gap-5 text-sm">
            <form action={setRegistrationAction} className="flex flex-wrap items-center gap-3">
              <span>{registration === 'approval' ? t('registrationOn') : t('registrationOff')}</span>
              <input type="hidden" name="mode" value={registration === 'approval' ? 'off' : 'approval'} />
              <Button type="submit" variant="outline" size="sm">
                {registration === 'approval' ? t('registrationTurnOff') : t('registrationTurnOn')}
              </Button>
            </form>
            {registration === 'approval' ? (
              <p className="text-xs text-muted-foreground">
                {t('registrationLink')}{' '}
                <span className="font-mono break-all text-foreground">{registerLink}</span>
              </p>
            ) : null}
            {requests.length > 0 ? (
              <div className="grid gap-2">
                <h3 className="text-sm font-medium">{t('requestsHeading', { count: requests.length })}</h3>
                <ul className="grid gap-2">
                  {requests.map((request) => (
                    <li
                      key={request.id}
                      className="grid gap-2 rounded-(--radius-base) border border-border px-3 py-2"
                    >
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <span className="font-medium">{request.name}</span>
                        <span className="font-mono text-xs text-muted-foreground">{request.email}</span>
                        <span className="text-xs text-muted-foreground">
                          {formatDateTime(format, request.createdAt) ?? ''}
                        </span>
                      </div>
                      {request.message ? (
                        <p className="whitespace-pre-wrap text-xs text-muted-foreground">{request.message}</p>
                      ) : null}
                      <div className="flex flex-wrap items-center gap-2">
                        <form action={decideAccessAction} className="flex items-center gap-2">
                          <input type="hidden" name="requestId" value={request.id} />
                          <input type="hidden" name="decision" value="approve" />
                          <Select name="role" defaultValue="viewer" aria-label={t('roleLabel')}>
                            <option value="viewer">{t('role_viewer')}</option>
                            <option value="editor">{t('role_editor')}</option>
                            <option value="admin">{t('role_admin')}</option>
                          </Select>
                          <Button type="submit" size="sm">
                            {t('approve')}
                          </Button>
                        </form>
                        <form action={decideAccessAction}>
                          <input type="hidden" name="requestId" value={request.id} />
                          <input type="hidden" name="decision" value="reject" />
                          <Button type="submit" variant="outline" size="sm">
                            {t('reject')}
                          </Button>
                        </form>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : registration === 'approval' ? (
              <p className="text-xs text-muted-foreground">{t('requestsNone')}</p>
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
                        <>
                          <ResetLinkButton userId={member.userId} name={member.name} />
                          <RemoveMemberButton userId={member.userId} name={member.name} />
                        </>
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
