import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { signOutAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { listOwnPendingRequests } from '@/lib/orgs/access';
import { getSessionContext, getSignedInUser } from '@/lib/session';
import { formatDateTime } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('pending');
  return { title: t('title') };
}

/** Where an account with no organization lands: what it asked for, and that it waits. */
export default async function PendingPage() {
  const user = await getSignedInUser();
  if (!user) redirect('/login');
  if (await getSessionContext()) redirect('/');

  const t = await getTranslations('pending');
  const tc = await getTranslations('common');
  const format = await getFormatter();
  const requests = await listOwnPendingRequests(user.id);

  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>
          {requests.length > 0 ? t('waiting', { name: user.name }) : t('noOrganization', { name: user.name })}
        </CardDescription>
      </CardHeader>
      <CardBody className="grid gap-4 text-sm">
        {requests.length > 0 ? (
          <ul className="grid gap-1">
            {requests.map((request) => (
              <li key={`${request.name}-${request.createdAt.toISOString()}`}>
                <span className="font-medium">{request.name}</span>{' '}
                <span className="text-xs text-muted-foreground">
                  {t('askedAt', { when: formatDateTime(format, request.createdAt) ?? '' })}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-xs text-muted-foreground">{t('hint')}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/pending" className="underline underline-offset-2">
            {t('check')}
          </Link>
          <form action={signOutAction}>
            <Button type="submit" variant="outline" size="sm">
              {tc('signOut')}
            </Button>
          </form>
        </div>
      </CardBody>
    </Card>
  );
}
