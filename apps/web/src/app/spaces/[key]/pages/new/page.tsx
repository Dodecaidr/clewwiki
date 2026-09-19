import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { PageForm } from '@/app/pages/page-form';
import { Alert, Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { getPageTree } from '@/lib/pages/service';
import { getSessionContext } from '@/lib/session';
import { flattenTree } from '@/lib/spaces/tree';
import { spaceHref, spacePageHref } from '@/lib/spaces/urls';
import { findSpaceByKey } from '@/lib/spaces/visibility';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('editor');
  return { title: t('newTitle') };
}

/**
 * A new page in a space. Where it goes is chosen from the space's tree — "Add
 * child page" on a page arrives here with that page preselected — and the
 * resulting path is shown rather than typed.
 */
export default async function NewSpacePage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ parent?: string; kind?: string }>;
}) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }

  const space = await findSpaceByKey(session, (await params).key);
  if (!space) {
    notFound();
  }

  const t = await getTranslations('editor');
  const ts = await getTranslations('spaces');
  const query = await searchParams;

  if (space.archivedAt) {
    return (
      <div className="grid gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('newTitle')}</h1>
        <Alert tone="error">{ts('archivedNoNewPages')}</Alert>
      </div>
    );
  }

  const parents = flattenTree(await getPageTree(session.workspace.id, space.id));
  const parentId = parents.some((entry) => entry.id === query.parent) ? (query.parent ?? '') : '';

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('newTitle')}</h1>
      <Card>
        <CardHeader>
          <CardTitle>{t('newHeading')}</CardTitle>
        </CardHeader>
        <CardBody>
          <PageForm
            mode="create"
            spaceKey={space.key}
            cancelHref={parentId ? spacePageHref(space.key, parentId) : spaceHref(space.key)}
            parents={parents}
            initial={{
              title: '',
              segment: '',
              parentId,
              kind: query.kind === 'human' ? 'human' : 'technical',
              summary: '',
              body: '',
            }}
          />
        </CardBody>
      </Card>
    </div>
  );
}
