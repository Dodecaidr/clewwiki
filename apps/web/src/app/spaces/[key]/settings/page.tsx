import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { ArchiveSpaceForm } from './archive-form';
import { RepositoryForm } from './repository-form';
import { RulesForm } from './rules-form';
import { SpaceDetailsForm } from './space-form';
import { Alert, Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { getPageTree } from '@/lib/pages/service';
import { readRepositorySettings } from '@/lib/repository/settings';
import { getSessionContext } from '@/lib/session';
import { getSpaceByKey } from '@/lib/spaces/service';
import { flattenTree } from '@/lib/spaces/tree';
import { spaceImportHref } from '@/lib/spaces/urls';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('spaces');
  return { title: t('settingsTitle') };
}

/**
 * Space settings, for an administrator: what the space is called and how it
 * introduces itself, which page is its home, which repository its anchors are
 * checked against, and whether it is archived. The key is shown, not edited.
 *
 * The repository token itself is never entered here — the field takes the
 * *name* of an environment variable the operator has set on the process. A
 * credential typed into a form ends up in the database, in backups, and in
 * every response that carries settings; a variable name ends up in none.
 */
export default async function SpaceSettingsPage({ params }: { params: Promise<{ key: string }> }) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }
  const space = await getSpaceByKey(session.workspace.id, (await params).key);
  if (!space) {
    notFound();
  }

  const t = await getTranslations('spaces');
  const tr = await getTranslations('repository');
  const trules = await getTranslations('rules');
  const timp = await getTranslations('imports');

  if (session.role !== 'admin') {
    return (
      <div className="grid gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('settingsTitle')}</h1>
        <Alert tone="info">{t('adminOnly')}</Alert>
      </div>
    );
  }

  const repository = readRepositorySettings(space.settings);
  const pages = flattenTree(await getPageTree(session.workspace.id, space.id));

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('settingsTitle')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('keyFixed', { key: space.key })}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('detailsHeading')}</CardTitle>
        </CardHeader>
        <CardBody>
          <SpaceDetailsForm
            spaceKey={space.key}
            pages={pages}
            initial={{
              name: space.name,
              description: space.description,
              icon: space.icon ?? '',
              homePageId: space.homePageId ?? '',
            }}
          />
        </CardBody>
      </Card>

      <Card id="rules" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>{trules('settingsHeading')}</CardTitle>
          <CardDescription>{trules('settingsIntro')}</CardDescription>
        </CardHeader>
        <CardBody>
          <RulesForm
            spaceKey={space.key}
            pages={pages}
            rulesPageId={space.rulesPageId ?? ''}
            hasRules={space.rulesPageId !== null}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{tr('formHeading')}</CardTitle>
          <CardDescription>
            {tr('intro')} {tr('formIntro')}
          </CardDescription>
        </CardHeader>
        <CardBody>
          <RepositoryForm
            spaceKey={space.key}
            initial={{
              url: repository?.url ?? '',
              defaultRef: repository?.default_ref ?? '',
              authTokenEnv: repository?.auth_token_env ?? '',
            }}
            labels={{
              url: tr('url'),
              urlHint: tr('urlHint'),
              ref: tr('ref'),
              refHint: tr('refHint'),
              tokenEnv: tr('tokenEnv'),
              tokenEnvHint: tr('tokenEnvHint'),
              save: tr('save'),
              test: tr('test'),
              saved: tr('saved'),
              testOk: tr('testOk'),
              testFailed: tr('testFailed'),
              errorForbidden: tr('errorForbidden'),
              errorValidation: tr('errorValidation'),
            }}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{timp('title')}</CardTitle>
          <CardDescription>{timp('settingsIntro')}</CardDescription>
        </CardHeader>
        <CardBody>
          <Link
            href={spaceImportHref(space.key)}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            {timp('openImport')}
          </Link>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{space.archivedAt ? t('unarchiveHeading') : t('archiveHeading')}</CardTitle>
          <CardDescription>
            {space.archivedAt ? t('unarchiveIntro') : t('archiveIntro')}
          </CardDescription>
        </CardHeader>
        <CardBody>
          <ArchiveSpaceForm spaceKey={space.key} archived={space.archivedAt !== null} />
        </CardBody>
      </Card>
    </div>
  );
}
