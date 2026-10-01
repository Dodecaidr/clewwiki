import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { signOutAction } from '@/app/actions';
import { LanguageSwitcher } from '@/components/language-switcher';
import { SearchBox } from '@/components/search-box';
import { ViewSwitcher } from '@/components/view-switcher';
import { Button } from '@/components/ui/button';
import { countUnread } from '@/lib/inbox/service';
import { countPendingAccessRequests } from '@/lib/orgs/access';
import { getSessionContext } from '@/lib/session';
import { spaceHref } from '@/lib/spaces/urls';
import { findSpaces } from '@/lib/spaces/visibility';
import { isInstanceAdmin, listMembershipsForUser } from '@/lib/workspace';
import { shellWidthClass } from '@/lib/view/prefs';
import type { Theme, Width } from '@/lib/view/prefs';

const linkClass = 'whitespace-nowrap text-muted-foreground hover:text-foreground';

export async function SiteHeader({ view }: { view: { theme: Theme; width: Width } }) {
  const t = await getTranslations('nav');
  const tc = await getTranslations('common');
  const session = await getSessionContext();
  const spaces = session ? await findSpaces(session) : [];
  const unread = session
    ? await countUnread({
        workspaceId: session.workspace.id,
        actor: { type: 'user', id: session.userId },
        spaceIds: session.spaceIds,
      })
    : 0;
  const [orgs, instanceAdmin, pendingRequests] = session
    ? await Promise.all([
        listMembershipsForUser(session.userId),
        isInstanceAdmin(session.userId),
        session.role === 'admin' ? countPendingAccessRequests(session.workspace.id) : Promise.resolve(0),
      ])
    : [[], false, 0];
  // Only worth a menu when there is somewhere else to go.
  const showOrgs = session !== null && (orgs.length > 1 || instanceAdmin);

  return (
    <header className="border-b border-border">
      <nav className={`mx-auto flex w-full ${shellWidthClass(view.width)} flex-wrap items-center gap-x-6 gap-y-3 px-6 py-4`}>
        <Link href="/" className="font-semibold tracking-tight">
          clewwiki
        </Link>
        {showOrgs && session ? (
          <details className="relative text-sm">
            <summary className={`${linkClass} cursor-pointer list-none font-medium text-foreground`}>
              {session.workspace.name} ▾
            </summary>
            <ul className="absolute left-0 z-30 mt-1 grid max-h-80 w-60 gap-0.5 overflow-y-auto rounded-(--radius-base) border border-border bg-card p-1 shadow-sm">
              {orgs.map((org) => (
                <li key={org.workspaceId}>
                  {org.workspaceId === session.workspaceId ? (
                    <span className="flex items-center gap-2 rounded-(--radius-base) bg-secondary px-2 py-1.5 font-medium">
                      <span className="truncate">{org.name}</span>
                    </span>
                  ) : (
                    // A plain link to the organization's entrance: it switches
                    // and lands on its home without any script.
                    <a
                      href={`/o/${org.slug}`}
                      className="flex items-center gap-2 rounded-(--radius-base) px-2 py-1.5 hover:bg-secondary"
                    >
                      <span className="truncate">{org.name}</span>
                    </a>
                  )}
                </li>
              ))}
              <li className="border-t border-border pt-0.5">
                <Link href="/orgs" className="block rounded-(--radius-base) px-2 py-1.5 text-muted-foreground hover:bg-secondary">
                  {t('organizations')}
                </Link>
              </li>
            </ul>
          </details>
        ) : null}
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
              <Link href="/inbox" className={linkClass}>
                {t('inbox')}
                {unread > 0 ? (
                  <span
                    className="ml-1.5 rounded-full bg-foreground px-1.5 py-0.5 text-[10px] font-semibold text-background"
                    aria-label={t('inboxUnread', { count: unread })}
                  >
                    {unread > 99 ? '99+' : unread}
                  </span>
                ) : null}
              </Link>
              <Link href="/presence" className={linkClass}>
                {t('presence')}
              </Link>
              <Link href="/settings/members" className={linkClass}>
                {t('members')}
                {pendingRequests > 0 ? (
                  <span
                    className="ml-1.5 rounded-full bg-warning px-1.5 py-0.5 text-[10px] font-semibold text-background"
                    aria-label={t('accessRequests', { count: pendingRequests })}
                  >
                    {pendingRequests}
                  </span>
                ) : null}
              </Link>
              <Link href="/settings/trackers" className={linkClass}>
                {t('trackers')}
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
          <ViewSwitcher theme={view.theme} width={view.width} />
          {session ? (
            <Link href="/settings/account" className={`${linkClass} text-sm`} title={t('account')}>
              {session.name}
            </Link>
          ) : null}
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
