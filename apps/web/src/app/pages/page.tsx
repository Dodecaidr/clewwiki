import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { listPages } from '@/lib/pages/service';
import { getSessionContext } from '@/lib/session';
import { formatDateTime } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('pages');
  return { title: t('title') };
}

export default async function PagesIndex() {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }

  const t = await getTranslations('pages');
  const format = await getFormatter();
  const recent = await listPages(session.workspace.id, { limit: 20 });
  const sorted = [...recent].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      {sorted.length === 0 ? (
        <Card>
          <CardBody className="grid justify-items-start gap-4 text-sm">
            <p className="text-muted-foreground">{t('emptyIntro')}</p>
            <div className="flex flex-wrap items-center gap-4">
              <Link href="/pages/new" className={buttonVariants({ size: 'sm' })}>
                {t('new')}
              </Link>
              <Link href="/guide" className="text-sm underline underline-offset-2 hover:text-foreground">
                {t('whatIsThis')}
              </Link>
            </div>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t('recentHeading')}</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="grid gap-3 text-sm">
              {sorted.map((page) => (
                <li key={page.id} className="grid gap-0.5">
                  <Link
                    href={`/pages/${page.id}`}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {page.title}
                  </Link>
                  <span className="font-mono text-xs text-muted-foreground">{page.path}</span>
                  <span className="text-xs text-muted-foreground">
                    {t('kindLabel')}: {t(`kind_${page.kind}`)} · {t('updatedLabel')}:{' '}
                    {formatDateTime(format, page.updatedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
