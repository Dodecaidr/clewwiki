import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { PageForm } from '../../page-form';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { getPageById, listPages } from '@/lib/pages/service';
import { getSessionContext } from '@/lib/session';
import { assertSameWorkspace } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }> };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('editor');
  return { title: t('editTitle') };
}

export default async function EditPage({ params }: Props) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }

  const { id } = await params;
  if (!UUID_PATTERN.test(id)) {
    notFound();
  }

  const page = await getPageById(session.workspace.id, id);
  if (!page) {
    notFound();
  }
  assertSameWorkspace(session.workspace.id, page.workspaceId);

  const t = await getTranslations('editor');
  const candidates = await listPages(session.workspace.id, { limit: 500 });

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('editTitle')}</h1>
      <Card>
        <CardHeader>
          <CardTitle>{page.title}</CardTitle>
        </CardHeader>
        <CardBody>
          <PageForm
            mode="edit"
            cancelHref={`/pages/${page.id}`}
            parents={candidates
              // A page cannot be its own parent, and the subtree check that
              // catches a deeper cycle lives in the service.
              .filter((candidate) => candidate.id !== page.id)
              .map((candidate) => ({
                id: candidate.id,
                title: candidate.title,
                path: candidate.path,
              }))}
            initial={{
              pageId: page.id,
              // Carried through the form so the save is refused if someone
              // else writes to the page while it is open.
              baseContentHash: page.contentHash,
              title: page.title,
              path: page.path,
              parentId: page.parentId ?? '',
              kind: page.kind,
              summary: page.summary ?? '',
              body: page.body,
            }}
          />
        </CardBody>
      </Card>
    </div>
  );
}
