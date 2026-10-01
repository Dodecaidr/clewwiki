import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { readRegistrationMode } from '@/lib/orgs/access';
import { getSignedInUser } from '@/lib/session';
import { getMembership, getWorkspaceBySlug, hasAnyUser } from '@/lib/workspace';

import { RegisterForm } from './register-form';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('register');
  return { title: t('title') };
}

/**
 * Asking to join one organization. Only answers when that organization takes
 * requests; otherwise it does not exist, so the page reveals nothing about
 * which organizations are on the instance.
 */
export default async function RegisterPage({ params }: { params: Promise<{ slug: string }> }) {
  if (!(await hasAnyUser())) redirect('/setup');
  const { slug } = await params;
  const workspace = await getWorkspaceBySlug(slug.toLowerCase());
  if (!workspace || readRegistrationMode(workspace) !== 'approval') notFound();

  const user = await getSignedInUser();
  if (user && (await getMembership(user.id, workspace.id))) redirect(`/o/${workspace.slug}`);
  const t = await getTranslations('register');

  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <CardTitle>{t('heading', { org: workspace.name })}</CardTitle>
        <CardDescription>{user ? t('introSignedIn', { name: user.name }) : t('intro')}</CardDescription>
      </CardHeader>
      <CardBody className="grid gap-4">
        <RegisterForm org={workspace.slug} signedIn={user !== null} />
        {user ? null : (
          <p className="text-xs text-muted-foreground">
            {t('haveAccount')}{' '}
            <Link href={`/login?org=${workspace.slug}`} className="underline underline-offset-2">
              {t('signIn')}
            </Link>
          </p>
        )}
      </CardBody>
    </Card>
  );
}
