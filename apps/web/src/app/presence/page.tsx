import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { PresenceAutoRefresh } from './auto-refresh';
import { ForceReleaseButton } from './force-release-button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { getPresence } from '@/lib/claims/service';
import { remainingSeconds } from '@/lib/claims/ttl';
import { getSessionContext } from '@/lib/session';
import { formatDateTime } from '@/lib/utils';

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
export default async function PresencePage() {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }

  const t = await getTranslations('presence');
  const format = await getFormatter();
  const presence = await getPresence(session.workspace.id);
  const now = new Date();

  return (
    <div className="grid gap-6">
      <PresenceAutoRefresh />

      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
      </div>

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
                        href={`/pages/${entry.claim.pageId}`}
                        className="font-medium underline-offset-2 hover:underline"
                      >
                        {entry.title}
                      </Link>
                      <div className="font-mono text-xs text-muted-foreground">{entry.path}</div>
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
