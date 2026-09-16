import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { signOutAction } from '@/app/actions';
import { SearchBox } from '@/components/search-box';
import { Button } from '@/components/ui/button';
import { getSessionContext } from '@/lib/session';

export async function SiteHeader() {
  const t = await getTranslations('nav');
  const tc = await getTranslations('common');
  const session = await getSessionContext();

  return (
    <header className="border-b border-border">
      <nav className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-4">
        <Link href="/" className="font-semibold tracking-tight">
          clewwiki
        </Link>
        <div className="flex flex-1 flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          {session ? (
            <>
              <Link href="/pages" className="text-muted-foreground hover:text-foreground">
                {t('pages')}
              </Link>
              <Link href="/presence" className="text-muted-foreground hover:text-foreground">
                {t('presence')}
              </Link>
              <Link href="/tokens" className="text-muted-foreground hover:text-foreground">
                {t('tokens')}
              </Link>
            </>
          ) : null}
          <Link href="/about" className="text-muted-foreground hover:text-foreground">
            {t('about')}
          </Link>
        </div>
        {session ? <SearchBox /> : null}
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
      </nav>
    </header>
  );
}
