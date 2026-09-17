import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { LoginForm } from './login-form';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LanguageSwitcher } from '@/components/language-switcher';
import { getSessionContext } from '@/lib/session';
import { hasAnyUser } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('login');
  return { title: t('title') };
}

export default async function LoginPage() {
  // A fresh instance has nothing to sign in to yet; send the visitor to setup.
  if (!(await hasAnyUser())) {
    redirect('/setup');
  }

  if (await getSessionContext()) {
    redirect('/');
  }

  const t = await getTranslations('login');

  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle>{t('title')}</CardTitle>
          <LanguageSwitcher />
        </div>
        <CardDescription>{t('intro')}</CardDescription>
      </CardHeader>
      <CardBody>
        <LoginForm />
      </CardBody>
    </Card>
  );
}
