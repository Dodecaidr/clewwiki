import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { LoginForm } from './login-form';
import { SsoButton } from './sso-button';
import { Alert, Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LanguageSwitcher } from '@/components/language-switcher';
import { oidcProvider } from '@/lib/auth';
import { getSessionContext } from '@/lib/session';
import { hasAnyUser } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('login');
  return { title: t('title') };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string; sso?: string }>;
}) {
  // A fresh instance has nothing to sign in to yet; send the visitor to setup.
  if (!(await hasAnyUser())) {
    redirect('/setup');
  }

  if (await getSessionContext()) {
    redirect('/');
  }

  const t = await getTranslations('login');
  const query = await searchParams;
  const provider = oidcProvider();

  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle>{t('title')}</CardTitle>
          <LanguageSwitcher />
        </div>
        <CardDescription>{t('intro')}</CardDescription>
      </CardHeader>
      <CardBody className="grid gap-4">
        {query.reset === 'done' ? <Alert tone="info">{t('resetDone')}</Alert> : null}
        {query.sso === 'denied' ? <Alert tone="error">{t('ssoDenied')}</Alert> : null}
        {query.sso === 'failed' ? <Alert tone="error">{t('ssoFailed')}</Alert> : null}
        <LoginForm />
        {provider === null ? null : <SsoButton name={provider.name} />}
      </CardBody>
    </Card>
  );
}
