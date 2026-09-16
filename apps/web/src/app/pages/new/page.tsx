import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { PageForm } from '../page-form';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { listPages } from '@/lib/pages/service';
import { getSessionContext } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('editor');
  return { title: t('newTitle') };
}

export default async function NewPage({
  searchParams,
}: {
  searchParams: Promise<{ parent?: string; kind?: string }>;
}) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }

  const t = await getTranslations('editor');
  const query = await searchParams;
  const candidates = await listPages(session.workspace.id, { limit: 500 });

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
            cancelHref="/pages"
            parents={candidates.map((page) => ({
              id: page.id,
              title: page.title,
              path: page.path,
            }))}
            initial={{
              title: '',
              path: '',
              parentId: query.parent ?? '',
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
