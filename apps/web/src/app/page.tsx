import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { getSessionContext } from '@/lib/session';
import { hasAnyUser } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  // A fresh instance has no accounts, so the first visit goes to setup. This is
  // the only path by which an administrator account comes into existence.
  if (!(await hasAnyUser())) {
    redirect('/setup');
  }

  const session = await getSessionContext();
  const t = await getTranslations('home');

  return (
    <div className="grid gap-8">
      <div className="grid gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="max-w-2xl text-muted-foreground">{t('tagline')}</p>
      </div>

      {session ? (
        <Card>
          <CardHeader>
            <CardTitle>{session.workspace.name}</CardTitle>
          </CardHeader>
          <CardBody className="grid gap-4 text-sm">
            <dl className="grid gap-2 sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">{t('workspaceLabel')}</dt>
                <dd className="font-medium">{session.workspace.name}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('roleLabel')}</dt>
                <dd className="font-medium">
                  {session.role === 'admin' ? t('role_admin') : t('role_editor')}
                </dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-4">
              <Link
                href="/pages"
                className="text-sm underline underline-offset-2 hover:text-foreground"
              >
                {t('browsePages')}
              </Link>
              <Link
                href="/tokens"
                className="text-sm underline underline-offset-2 hover:text-foreground"
              >
                {t('manageTokens')}
              </Link>
              <Link
                href="/connect"
                className="text-sm underline underline-offset-2 hover:text-foreground"
              >
                {t('connectAgent')}
              </Link>
              <Link
                href="/guide"
                className="text-sm underline underline-offset-2 hover:text-foreground"
              >
                {t('readGuide')}
              </Link>
            </div>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardBody className="text-sm text-muted-foreground">
            <p>
              {t('signedOutHint')}{' '}
              <Link href="/login" className="underline underline-offset-2 hover:text-foreground">
                {t('signInLink')}
              </Link>
            </p>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('apiHeading')}</CardTitle>
        </CardHeader>
        <CardBody className="grid gap-3 text-sm">
          <p className="text-muted-foreground">{t('apiIntro')}</p>
          <dl className="grid gap-3">
            <div>
              <dt className="font-mono text-xs">GET /api/v1/health</dt>
              <dd className="text-muted-foreground">{t('apiHealth')}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs">GET /api/v1/me</dt>
              <dd className="text-muted-foreground">{t('apiMe')}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs">GET, POST /api/v1/pages</dt>
              <dd className="text-muted-foreground">{t('apiPages')}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs">POST /api/v1/pages/&#123;id&#125;/claims</dt>
              <dd className="text-muted-foreground">{t('apiClaims')}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs">GET /api/v1/claims</dt>
              <dd className="text-muted-foreground">{t('apiPresence')}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs">GET /api/v1/search?q=</dt>
              <dd className="text-muted-foreground">{t('apiSearch')}</dd>
            </div>
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}
