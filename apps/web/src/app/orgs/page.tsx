import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getAuthBaseUrl } from '@/lib/env';
import { listAllOrganizations } from '@/lib/orgs/service';
import { getSessionContext, getSignedInUser } from '@/lib/session';
import { isInstanceAdmin, listMembershipsForUser } from '@/lib/workspace';

import { switchOrganizationAction } from './actions';
import { CreateOrgForm } from './create-org-form';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('orgs');
  return { title: t('title') };
}

/**
 * The organizations of the signed-in account, a switch between them, and —
 * for an instance administrator — every organization on the instance and the
 * form that creates one.
 */
export default async function OrganizationsPage() {
  const user = await getSignedInUser();
  if (!user) redirect('/login');

  const t = await getTranslations('orgs');
  const [mine, admin, session] = await Promise.all([
    listMembershipsForUser(user.id),
    isInstanceAdmin(user.id),
    getSessionContext(),
  ]);
  const all = admin ? await listAllOrganizations(user.id) : [];
  const base = getAuthBaseUrl().replace(/\/+$/, '');
  const mineIds = new Set(mine.map((org) => org.workspaceId));

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('mineHeading')}</CardTitle>
        </CardHeader>
        <CardBody>
          {mine.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('mineNone')}</p>
          ) : (
            <ul className="grid gap-2">
              {mine.map((org) => {
                const current = session?.workspaceId === org.workspaceId;
                return (
                  <li
                    key={org.workspaceId}
                    className="flex flex-wrap items-center gap-3 rounded-(--radius-base) border border-border px-3 py-2 text-sm"
                  >
                    <span className="font-medium">{org.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">/o/{org.slug}</span>
                    <span className="text-xs text-muted-foreground">{t(`role_${org.role}`)}</span>
                    <span className="ml-auto">
                      {current ? (
                        <span className="text-xs text-muted-foreground">{t('current')}</span>
                      ) : (
                        <form action={switchOrganizationAction}>
                          <input type="hidden" name="workspaceId" value={org.workspaceId} />
                          <Button type="submit" variant="outline" size="sm">
                            {t('switch')}
                          </Button>
                        </form>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      {admin ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('createHeading')}</CardTitle>
              <CardDescription>{t('createIntro')}</CardDescription>
            </CardHeader>
            <CardBody>
              <CreateOrgForm />
            </CardBody>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('allHeading', { count: all.length })}</CardTitle>
              <CardDescription>{t('allIntro')}</CardDescription>
            </CardHeader>
            <CardBody>
              <ul className="grid gap-2">
                {all.map((org) => (
                  <li
                    key={org.id}
                    className="flex flex-wrap items-center gap-3 rounded-(--radius-base) border border-border px-3 py-2 text-sm"
                  >
                    <span className="font-medium">{org.name}</span>
                    <span className="font-mono text-xs text-muted-foreground break-all">
                      {base}/o/{org.slug}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t('memberCount', { count: org.memberCount })}
                    </span>
                    {mineIds.has(org.id) ? null : (
                      <span className="ml-auto text-xs text-muted-foreground">{t('notMember')}</span>
                    )}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </>
      ) : null}
    </div>
  );
}
