import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { RepositoryForm } from './repository-form';
import { Alert, Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { readRepositorySettings } from '@/lib/repository/settings';
import { getSessionContext } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('repository');
  return { title: t('title') };
}

/**
 * Where an administrator links the workspace to a source repository.
 *
 * The token itself is never entered here — the field takes the *name* of an
 * environment variable the operator has set on the process. A credential typed
 * into a form ends up in the database, in backups, and in every response that
 * carries workspace settings; a variable name ends up in none of those.
 */
export default async function RepositorySettingsPage() {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }

  const t = await getTranslations('repository');
  const repository = readRepositorySettings(session.workspace.settings);

  return (
    <div className="mx-auto grid w-full max-w-2xl gap-6">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </header>

      {session.role !== 'admin' ? (
        <Alert tone="info">{t('adminOnly')}</Alert>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t('formHeading')}</CardTitle>
            <CardDescription>{t('formIntro')}</CardDescription>
          </CardHeader>
          <CardBody>
            <RepositoryForm
              initial={{
                url: repository?.url ?? '',
                defaultRef: repository?.default_ref ?? '',
                authTokenEnv: repository?.auth_token_env ?? '',
              }}
              labels={{
                url: t('url'),
                urlHint: t('urlHint'),
                ref: t('ref'),
                refHint: t('refHint'),
                tokenEnv: t('tokenEnv'),
                tokenEnvHint: t('tokenEnvHint'),
                save: t('save'),
                test: t('test'),
                saved: t('saved'),
                testOk: t('testOk'),
                testFailed: t('testFailed'),
                errorForbidden: t('errorForbidden'),
                errorValidation: t('errorValidation'),
              }}
            />
          </CardBody>
        </Card>
      )}
    </div>
  );
}
