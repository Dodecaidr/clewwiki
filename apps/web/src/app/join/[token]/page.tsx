import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { Alert, Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { findOpenInvitation } from '@/lib/members/service';
import { getWorkspaceById } from '@/lib/workspace';

import { JoinForm } from './join-form';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('join');
  // The link is a secret: it must not be kept by a search engine or sent on as a referrer.
  return { title: t('title'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const t = await getTranslations('join');
  const { token } = await params;
  const invitation = await findOpenInvitation(decodeURIComponent(token));
  const workspace = invitation ? await getWorkspaceById(invitation.workspaceId) : null;

  return (
    <div className="mx-auto grid w-full max-w-md gap-6">
      {invitation && workspace ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('heading', { workspace: workspace.name })}</CardTitle>
            <CardDescription>{t(`intro_${invitation.role}`)}</CardDescription>
          </CardHeader>
          <CardBody>
            <JoinForm token={token} email={invitation.email} />
          </CardBody>
        </Card>
      ) : (
        <Alert tone="error">{t('invalid')}</Alert>
      )}
    </div>
  );
}
