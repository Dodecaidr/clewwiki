import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { Alert, Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { findOpenPasswordReset } from '@/lib/members/account';

import { ResetForm } from './reset-form';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('reset');
  // The link is a secret: it must not be kept by a search engine or sent on as a referrer.
  return { title: t('title'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const t = await getTranslations('reset');
  const { token } = await params;
  const reset = await findOpenPasswordReset(decodeURIComponent(token));

  return (
    <div className="mx-auto grid w-full max-w-md gap-6">
      {reset ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('heading')}</CardTitle>
            <CardDescription>{t('intro')}</CardDescription>
          </CardHeader>
          <CardBody>
            <ResetForm token={token} email={reset.email} />
          </CardBody>
        </Card>
      ) : (
        <Alert tone="error">{t('invalid')}</Alert>
      )}
    </div>
  );
}
