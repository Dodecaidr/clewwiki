import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { signOutAction } from '@/app/actions';
import { LanguageSwitcher } from '@/components/language-switcher';
import { SearchBox } from '@/components/search-box';
import { Button } from '@/components/ui/button';
import { getSessionContext } from '@/lib/session';

const linkClass = 'whitespace-nowrap text-muted-foreground hover:text-foreground';

export async function SiteHeader() {
  const t = await getTranslations('nav');
  const tc = await getTranslations('common');
  const session = await getSessionContext();

  return (
    <header className="border-b border-border">
      <nav className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-4">
        <Link href="/" className="font-semibold tracking-tight">
          clewwiki
        </Link>
        {/* On a narrow screen the links wrap onto their own rows; each label
            stays on one line so a two-word label never breaks in the middle. */}
        <div className="flex flex-1 basis-full flex-wrap items-center gap-x-5 gap-y-2 text-sm sm:basis-auto">
          {session ? (
            <>
              <Link href="/pages" className={linkClass}>
                {t('pages')}
              </Link>
              <Link href="/presence" className={linkClass}>
                {t('presence')}
              </Link>
              <Link href="/tokens" className={linkClass}>
                {t('tokens')}
              </Link>
              <Link href="/connect" className={linkClass}>
                {t('connect')}
              </Link>
              <Link href="/settings/repository" className={linkClass}>
                {t('repository')}
              </Link>
              <Link href="/guide" className={linkClass}>
                {t('guide')}
              </Link>
            </>
          ) : null}
          <Link href="/about" className={linkClass}>
            {t('about')}
          </Link>
        </div>
        <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
          {session ? <SearchBox /> : null}
          <LanguageSwitcher />
          {session ? (
            <form action={signOutAction}>
              <Button type="submit" variant="outline" size="sm">
                {tc('signOut')}
              </Button>
            </form>
          ) : (
            <Link
              href="/login"
              className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {t('signIn')}
            </Link>
          )}
        </div>
      </nav>
    </header>
  );
}
