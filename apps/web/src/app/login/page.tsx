import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { LoginForm } from './login-form';
import { SsoButton } from './sso-button';
import { Alert, Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LanguageSwitcher } from '@/components/language-switcher';
import { oidcProvider } from '@/lib/auth';
import { readRegistrationMode } from '@/lib/orgs/access';
import { getSessionContext, getSignedInUser } from '@/lib/session';
import { DEFAULT_WORKSPACE_SLUG, getWorkspaceBySlug, hasAnyUser } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('login');
  return { title: t('title') };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string; sso?: string; org?: string; next?: string }>;
}) {
  // A fresh instance has nothing to sign in to yet; send the visitor to setup.
  if (!(await hasAnyUser())) {
    redirect('/setup');
  }

  if (await getSessionContext()) {
    redirect('/');
  }
  // Signed in, but in no organization yet: that is the waiting page's to say.
  if (await getSignedInUser()) {
    redirect('/pending');
  }

  const t = await getTranslations('login');
  const query = await searchParams;
  const provider = oidcProvider();
  // The organization whose entrance this is, if any. An unknown slug is not
  // reported as unknown: the page simply is the plain sign-in page.
  const org = query.org ? await getWorkspaceBySlug(query.org.toLowerCase()) : null;
  const requestsFrom = org ?? (await getWorkspaceBySlug(DEFAULT_WORKSPACE_SLUG));
  const registerHref =
    requestsFrom && readRegistrationMode(requestsFrom) === 'approval' ? `/o/${requestsFrom.slug}/register` : null;

  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle>{org ? t('titleOrg', { org: org.name }) : t('title')}</CardTitle>
          <LanguageSwitcher />
        </div>
        <CardDescription>{t('intro')}</CardDescription>
      </CardHeader>
      <CardBody className="grid gap-4">
        {query.reset === 'done' ? <Alert tone="info">{t('resetDone')}</Alert> : null}
        {query.sso === 'denied' ? <Alert tone="error">{t('ssoDenied')}</Alert> : null}
        {query.sso === 'failed' ? <Alert tone="error">{t('ssoFailed')}</Alert> : null}
        <LoginForm org={org?.slug} next={query.next} />
        {provider === null ? null : <SsoButton name={provider.name} />}
        <p className="text-xs text-muted-foreground">
          {registerHref ? (
            <>
              {t('noAccount')}{' '}
              <Link href={registerHref} className="underline underline-offset-2 hover:text-foreground">
                {t('requestAccess')}
              </Link>
            </>
          ) : (
            t('inviteOnly')
          )}
        </p>
      </CardBody>
    </Card>
  );
}
