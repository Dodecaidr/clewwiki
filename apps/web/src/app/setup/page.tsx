import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { SetupForm } from './setup-form';
import { Card, CardBody, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ensureSetupToken } from '@/lib/setup-token';
import { hasAnyUser } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('setup');
  return { title: t('title') };
}

/**
 * First-run setup. The route exists only while the instance has no accounts;
 * afterwards it answers 404, so there is no window in which an unauthenticated
 * visitor can reach an account-creation form on a running instance.
 */
export default async function SetupPage() {
  if (await hasAnyUser()) {
    notFound();
  }

  // Normally generated and printed at start-up already; this covers a start-up
  // that could not reach the database. Idempotent: it prints only once.
  ensureSetupToken();

  const t = await getTranslations('setup');

  return (
    <Card className="mx-auto max-w-xl">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('intro')}</CardDescription>
      </CardHeader>
      <CardBody>
        <SetupForm />
      </CardBody>
    </Card>
  );
}
