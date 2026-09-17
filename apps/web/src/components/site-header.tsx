import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { signOutAction } from '@/app/actions';
import { LanguageSwitcher } from '@/components/language-switcher';
import { SearchBox } from '@/components/search-box';
import { Button } from '@/components/ui/button';
import { getSessionContext } from '@/lib/session';
import { listSpaces } from '@/lib/spaces/service';
import { spaceHref } from '@/lib/spaces/urls';

const linkClass = 'whitespace-nowrap text-muted-foreground hover:text-foreground';

export async function SiteHeader() {
  const t = await getTranslations('nav');
  const tc = await getTranslations('common');
  const session = await getSessionContext();
  const spaces = session ? await listSpaces(session.workspace.id) : [];

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
              <Link href="/" className={linkClass}>
                {t('spaces')}
              </Link>
              {spaces.length > 0 ? (
                // A details/summary menu: a list of links, nothing that has to
                // load before it works.
                <details className="relative">
                  <summary className={`${linkClass} cursor-pointer list-none`}>
                    {t('switchSpace')} ▾
                  </summary>
                  <ul className="absolute left-0 z-20 mt-1 grid max-h-80 w-56 gap-0.5 overflow-y-auto rounded-(--radius-base) border border-border bg-card p-1 shadow-sm">
                    {spaces.map((space) => (
                      <li key={space.id}>
                        <Link
                          href={spaceHref(space.key)}
                          className="flex items-center gap-2 rounded-(--radius-base) px-2 py-1.5 hover:bg-secondary"
                        >
                          {space.icon ? <span aria-hidden>{space.icon}</span> : null}
                          <span className="truncate">{space.name}</span>
                          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                            {space.key}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              <Link href="/presence" className={linkClass}>
                {t('presence')}
              </Link>
              <Link href="/tokens" className={linkClass}>
                {t('tokens')}
              </Link>
              <Link href="/connect" className={linkClass}>
                {t('connect')}
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
