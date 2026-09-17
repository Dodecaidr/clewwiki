import { getTranslations } from 'next-intl/server';

import { Input } from '@/components/ui/field';

/**
 * The search box in the top bar.
 *
 * A plain GET form: the results page is a URL, so a search can be linked,
 * bookmarked and reloaded, and the box works before any JavaScript arrives.
 */
export async function SearchBox() {
  const t = await getTranslations('search');

  return (
    <form action="/search" method="get" role="search" className="min-w-40 flex-1 sm:w-56 sm:flex-none">
      <label htmlFor="site-search" className="sr-only">
        {t('label')}
      </label>
      <Input
        id="site-search"
        type="search"
        name="q"
        placeholder={t('placeholder')}
        className="h-8 text-sm"
        maxLength={200}
      />
    </form>
  );
}
