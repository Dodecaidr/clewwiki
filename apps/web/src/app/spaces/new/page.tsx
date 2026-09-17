import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { CreateSpaceForm } from './create-space-form';
import { Alert, Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { getSessionContext } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('spaces');
  return { title: t('createTitle') };
}

export default async function NewSpacePage() {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }
  const t = await getTranslations('spaces');

  return (
    <div className="mx-auto grid w-full max-w-2xl gap-6">
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('createTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('createIntro')}</p>
      </div>
      {session.role !== 'admin' ? (
        <Alert tone="info">{t('adminOnly')}</Alert>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t('createHeading')}</CardTitle>
          </CardHeader>
          <CardBody>
            <CreateSpaceForm />
          </CardBody>
        </Card>
      )}
    </div>
  );
}
