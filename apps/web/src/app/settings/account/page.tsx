import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { Alert, Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getSessionContext } from '@/lib/session';

import { NameForm, PasswordForm } from './account-forms';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('account');
  return { title: t('title') };
}

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ password?: string }> }) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }
  const t = await getTranslations('account');
  const tm = await getTranslations('members');

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="font-mono text-xs text-muted-foreground">
          {session.email} · {tm(`role_${session.role}`)}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('nameHeading')}</CardTitle>
        </CardHeader>
        <CardBody>
          <NameForm name={session.name} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('passwordHeading')}</CardTitle>
          <CardDescription>{t('passwordIntro')}</CardDescription>
        </CardHeader>
        <CardBody className="grid gap-4">
          {(await searchParams).password === 'changed' ? <Alert tone="info">{t('passwordSaved')}</Alert> : null}
          <PasswordForm email={session.email} />
        </CardBody>
      </Card>
    </div>
  );
}
