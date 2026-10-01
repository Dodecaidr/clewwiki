import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getTrackerToken } from '@/lib/env';
import { getSessionContext } from '@/lib/session';
import { readTrackers } from '@/lib/trackers/settings';

import { removeTrackerAction } from './actions';
import { TrackerForm } from './tracker-form';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('trackers');
  return { title: t('title') };
}

/**
 * The organization's issue trackers. Everybody sees which trackers are linked;
 * only administrators add and remove them. Whether a token is configured is
 * shown as yes or no — the value never leaves the environment.
 */
export default async function TrackersPage() {
  const session = await getSessionContext();
  if (!session) redirect('/login');
  const t = await getTranslations('trackers');
  const trackers = readTrackers(session.workspace);
  const isAdmin = session.role === 'admin';

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('listHeading', { count: trackers.length })}</CardTitle>
        </CardHeader>
        <CardBody>
          {trackers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('none')}</p>
          ) : (
            <ul className="grid gap-2 text-sm">
              {trackers.map((tracker) => {
                const readable = tracker.kind !== 'other' && getTrackerToken(tracker.token_env) !== null;
                return (
                  <li
                    key={tracker.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-(--radius-base) border border-border px-3 py-2"
                  >
                    <span className="font-medium">{tracker.name}</span>
                    <span className="text-xs text-muted-foreground">{tracker.kind === 'other' ? t('kindOther') : tracker.kind}</span>
                    <span className="font-mono text-xs break-all text-muted-foreground">{tracker.base_url}</span>
                    <span className="font-mono text-xs">{tracker.projects.join(', ')}</span>
                    <span className={readable ? 'text-xs text-success' : 'text-xs text-muted-foreground'}>
                      {readable
                        ? t('readable')
                        : tracker.token_env
                          ? t('tokenMissing', { name: tracker.token_env })
                          : t('linksOnly')}
                    </span>
                    {isAdmin ? (
                      <form action={removeTrackerAction} className="ml-auto">
                        <input type="hidden" name="trackerId" value={tracker.id} />
                        <Button type="submit" variant="outline" size="sm">
                          {t('remove')}
                        </Button>
                      </form>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      {isAdmin ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('addHeading')}</CardTitle>
            <CardDescription>{t('addIntro')}</CardDescription>
          </CardHeader>
          <CardBody>
            <TrackerForm />
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
