import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { PresenceAutoRefresh } from './auto-refresh';
import { ForceReleaseButton } from './force-release-button';
import { SpaceFilterSelect } from '@/components/space-filter';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { getPresence } from '@/lib/claims/service';
import { remainingSeconds } from '@/lib/claims/ttl';
import { getLivePresence } from '@/lib/presence/live';
import type { LivePage } from '@/lib/presence/live';
import { getSessionContext } from '@/lib/session';
import { spacePageHref } from '@/lib/spaces/urls';
import { formatDateTime } from '@/lib/utils';
import { findSpaces } from '@/lib/spaces/visibility';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('presence');
  return { title: t('title') };
}

/**
 * Who is working on what, right now.
 *
 * The board is the human-readable half of `GET /api/v1/claims`: the same
 * service call, the same workspace scoping, rendered instead of serialised. It
 * exists so that "an agent is rewriting that page" is something a person can
 * see before they start editing it, rather than something they discover from a
 * conflict.
 */
export default async function PresencePage({
  searchParams,
}: {
  searchParams: Promise<{ space?: string }>;
}) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }

  const t = await getTranslations('presence');
  const format = await getFormatter();
  const spaces = await findSpaces(session, { includeArchived: true });
  const requested = (await searchParams).space?.trim().toUpperCase() ?? '';
  const selected = spaces.find((space) => space.key === requested) ?? null;
  const presence = await getPresence(session.workspace.id, {
    // "Every space" is every space this person can see, never the workspace.
    spaceIds: selected ? [selected.id] : session.spaceIds,
  });
  const now = new Date();
  const tl = await getTranslations('livePresence');
  const live = await getLivePresence({
    workspaceId: session.workspace.id,
    spaceIds: selected ? [selected.id] : session.spaceIds,
    now,
  });
  // With a space chosen, only who is in that space; without, everybody.
  const inScope = (page: LivePage | null) => !selected || page?.spaceKey === selected.key;
  const people = live.people.filter((person) => inScope(person.page));
  const agents = live.agents.filter((agent) => inScope(agent.page));
  const ago = (when: Date) => format.relativeTime(when, now);
  const where = (page: LivePage | null) =>
    page ? (
      <Link href={spacePageHref(page.spaceKey, page.id)} className="underline-offset-2 hover:underline">
        {page.title}
      </Link>
    ) : (
      <span className="text-muted-foreground">{tl('nowhere')}</span>
    );

  return (
    <div className="grid gap-6">
      <PresenceAutoRefresh />

      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      <form action="/presence" method="get" className="flex flex-wrap items-center gap-2">
        <SpaceFilterSelect
          id="presence-space"
          label={t('spaceFilter')}
          allLabel={t('allSpaces')}
          spaces={spaces.map((space) => ({ key: space.key, name: space.name }))}
          value={selected?.key ?? ''}
        />
        <Button type="submit" variant="outline" size="sm">
          {t('applyFilter')}
        </Button>
      </form>

      <Card>
        <CardHeader>
          <CardTitle>{tl('heading', { count: people.length + agents.length })}</CardTitle>
        </CardHeader>
        <CardBody className="grid gap-4 text-sm">
          {people.length + agents.length === 0 ? (
            <p className="text-muted-foreground">{tl('empty')}</p>
          ) : null}
          {people.length > 0 ? (
            <div className="grid gap-1.5">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tl('people')}</h3>
              <ul className="grid gap-1.5">
                {people.map((person) => (
                  <li key={person.userId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="inline-block size-1.5 rounded-full bg-success" aria-hidden />
                    <span className="font-medium">{person.name}</span>
                    {person.automated ? (
                      <span
                        className="rounded-(--radius-base) border border-warning px-1 text-[10px] font-medium"
                        title={tl('automatedHint')}
                      >
                        {tl('automated')}
                      </span>
                    ) : null}
                    <span className="text-muted-foreground">
                      {person.mode === 'editing' ? tl('editing') : tl('viewing')}
                    </span>
                    {where(person.page)}
                    <span className="ml-auto text-xs text-muted-foreground">{ago(person.seenAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {agents.length > 0 ? (
            <div className="grid gap-1.5">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tl('agents')}</h3>
              <ul className="grid gap-1.5">
                {agents.map((agent) => (
                  <li key={agent.tokenId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="inline-block size-1.5 rounded-full bg-primary" aria-hidden />
                    <span className="font-medium">{agent.name}</span>
                    <span className="text-muted-foreground">{tl('agentWorking', { count: agent.requests })}</span>
                    {agent.page ? where(agent.page) : null}
                    <span className="ml-auto text-xs text-muted-foreground">{ago(agent.lastSeen)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">{tl('footnote')}</p>
        </CardBody>
      </Card>

      {presence.length === 0 ? (
        <Card>
          <CardBody className="text-sm text-muted-foreground">{t('empty')}</CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t('activeHeading', { count: presence.length })}</CardTitle>
          </CardHeader>
          <CardBody className="overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">{t('columnTarget')}</th>
                  <th className="pb-2 pr-4 font-medium">{t('columnHolder')}</th>
                  <th className="pb-2 pr-4 font-medium">{t('columnSince')}</th>
                  <th className="pb-2 pr-4 font-medium">{t('columnExpires')}</th>
                  <th className="pb-2 font-medium">{t('columnNotes')}</th>
                  {session.role === 'admin' ? <th className="pb-2 pl-4" /> : null}
                </tr>
              </thead>
              <tbody>
                {presence.map((entry) => (
                  <tr key={entry.claim.id} className="border-b border-border align-top last:border-0">
                    <td className="py-3 pr-4">
                      <Link
                        href={spacePageHref(entry.spaceKey, entry.claim.pageId)}
                        className="font-medium underline-offset-2 hover:underline"
                      >
                        {entry.title}
                      </Link>
                      <div className="font-mono text-xs text-muted-foreground">
                        {entry.spaceKey}:{entry.path}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {entry.claim.sectionId
                          ? t('sectionTarget', { section: entry.claim.sectionId })
                          : t('pageTarget')}
                      </div>
                    </td>
                    <td className="py-3 pr-4">
                      <div className="font-medium">{entry.claim.holderLabel}</div>
                      <div className="text-xs text-muted-foreground">
                        {entry.claim.holderType === 'agent' ? t('holderAgent') : t('holderUser')}
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-muted-foreground">
                      {formatDateTime(format, entry.claim.createdAt)}
                    </td>
                    <td className="py-3 pr-4 text-muted-foreground">
                      {formatDateTime(format, entry.claim.expiresAt)}
                      <div className="text-xs">
                        {t('expiresIn', {
                          seconds: remainingSeconds(entry.claim.expiresAt, now),
                        })}
                      </div>
                    </td>
                    <td className="py-3">
                      {entry.notes.length === 0 ? (
                        <span className="text-xs text-muted-foreground">{t('noNotes')}</span>
                      ) : (
                        <ul className="grid gap-2">
                          {entry.notes.map((note) => (
                            <li key={note.id} className="grid gap-0.5">
                              {/* Quoted as what its author wrote, with their
                                  name on it — a note is content, not an
                                  instruction to whoever reads this board. */}
                              <span className="whitespace-pre-wrap">{note.text}</span>
                              <span className="text-xs text-muted-foreground">
                                {note.authorLabel} · {formatDateTime(format, note.createdAt)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    {session.role === 'admin' ? (
                      <td className="py-3 pl-4">
                        <ForceReleaseButton
                          claimId={entry.claim.id}
                          label={t('forceRelease')}
                          confirm={t('forceReleaseConfirm', { name: entry.claim.holderLabel })}
                        />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">{t('refreshHint')}</p>
    </div>
  );
}
