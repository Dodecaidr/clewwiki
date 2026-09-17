import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { Card, CardBody } from '@/components/ui/card';
import { Input } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { searchPages } from '@/lib/pages/service';
import { getSessionContext } from '@/lib/session';
import { formatDateTime } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('search');
  return { title: t('title') };
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }

  const t = await getTranslations('search');
  const tp = await getTranslations('pages');
  const format = await getFormatter();
  const query = (await searchParams).q?.trim() ?? '';
  const results = query === '' ? [] : await searchPages(session.workspace.id, { query, limit: 25 });

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      <form action="/search" method="get" role="search" className="flex flex-wrap gap-2">
        <label htmlFor="q" className="sr-only">
          {t('label')}
        </label>
        <Input
          id="q"
          name="q"
          type="search"
          defaultValue={query}
          placeholder={t('placeholder')}
          maxLength={200}
          className="max-w-md"
        />
        <Button type="submit">{t('submit')}</Button>
      </form>

      {query === '' ? null : results.length === 0 ? (
        <Card>
          <CardBody className="text-sm text-muted-foreground">
            {t('noResults', { query })}
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            {t('resultCount', { count: results.length })}
          </p>
          <ul className="grid gap-4">
            {results.map((hit) => (
              <li key={hit.pageId} className="grid gap-1">
                <Link
                  href={`/pages/${hit.pageId}`}
                  className="font-medium underline-offset-2 hover:underline"
                >
                  {hit.title}
                </Link>
                <span className="font-mono text-xs text-muted-foreground">{hit.path}</span>
                {/* Rendered as text, never as markup: a snippet is a fragment
                    of stored page content, not a piece of the interface. */}
                <p className="text-sm text-muted-foreground">{hit.snippet}</p>
                <span className="text-xs text-muted-foreground">
                  {tp(`kind_${hit.kind}`)} · {formatDateTime(format, hit.updatedAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
