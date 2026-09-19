import { getTranslations } from 'next-intl/server';

import { listMentionSyntax } from '@/lib/mentions/service';
import { getSessionContext } from '@/lib/session';

/** How many names are spelled out before the rest become a number. */
const SHOWN = 12;

/**
 * The line under a message or comment box that says who can be brought in, and
 * how to write it. Names are shown already in mention form — `@backend-agent`,
 * `@[Ada Lovelace]` — so that copying one is all there is to learn.
 *
 * They are the workspace's members and live agent tokens: names every member
 * already sees next to whatever those people and agents write.
 */
export async function MentionHint() {
  const session = await getSessionContext();
  if (!session) return null;

  const names = await listMentionSyntax(session.workspace.id, { type: 'user', id: session.userId });
  if (names.length === 0) return null;

  const t = await getTranslations('mentions');
  return (
    <p className="text-xs leading-relaxed text-muted-foreground">
      {t('hint')}{' '}
      {names.slice(0, SHOWN).map((name, index) => (
        <span key={name}>
          {index > 0 ? ' · ' : ''}
          <code className="whitespace-nowrap rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">{name}</code>
        </span>
      ))}
      {names.length > SHOWN ? ` · ${t('more', { count: names.length - SHOWN })}` : ''}
    </p>
  );
}
