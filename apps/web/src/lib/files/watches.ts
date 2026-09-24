import 'server-only';

import { and, desc, eq, isNull } from 'drizzle-orm';
import { pages, spaces, watches } from '@clewwiki/db';

import { getDatabase } from '../db';
import { PageServiceError } from '../pages/errors';

/**
 * Watching a page or a space for new versions of its files.
 *
 * A watch sends nothing. It is what makes the inbox include a new version of
 * a file on that page, or anywhere in that space, uploaded by somebody else —
 * read, like every other inbox item, under the watcher's visibility at the
 * moment the inbox is opened. So a watch is safe to leave behind: one on a
 * space the watcher has since lost produces nothing, and one on a deleted page
 * goes with the page.
 */

export interface WatchActor {
  type: 'user' | 'agent';
  id: string;
}

export type WatchTarget = { kind: 'page'; id: string } | { kind: 'space'; id: string };
/** A target as a caller names it: a page by id, a space by key. */
export type RequestedWatchTarget = { kind: 'page'; id: string } | { kind: 'space'; key: string };

export interface WatchRecord {
  id: string;
  target: WatchTarget;
  /** The page's title or the space's name, for a list of what one is watching. */
  title: string;
  spaceKey: string;
  createdAt: Date;
}

function targetColumn(target: WatchTarget) {
  return target.kind === 'page' ? eq(watches.pageId, target.id) : eq(watches.spaceId, target.id);
}

/** Starts watching. Watching what one already watches changes nothing. */
export async function watch(workspaceId: string, actor: WatchActor, target: WatchTarget): Promise<boolean> {
  const inserted = await getDatabase()
    .insert(watches)
    .values({
      workspaceId,
      actorType: actor.type,
      actorId: actor.id,
      pageId: target.kind === 'page' ? target.id : null,
      spaceId: target.kind === 'space' ? target.id : null,
    })
    .onConflictDoNothing()
    .returning({ id: watches.id });
  return inserted.length > 0;
}

/** Stops watching. Answers whether there was a watch to stop. */
export async function unwatch(workspaceId: string, actor: WatchActor, target: WatchTarget): Promise<boolean> {
  const removed = await getDatabase()
    .delete(watches)
    .where(
      and(
        eq(watches.workspaceId, workspaceId),
        eq(watches.actorType, actor.type),
        eq(watches.actorId, actor.id),
        targetColumn(target),
      ),
    )
    .returning({ id: watches.id });
  return removed.length > 0;
}

export async function isWatching(workspaceId: string, actor: WatchActor, target: WatchTarget): Promise<boolean> {
  const [row] = await getDatabase()
    .select({ id: watches.id })
    .from(watches)
    .where(
      and(
        eq(watches.workspaceId, workspaceId),
        eq(watches.actorType, actor.type),
        eq(watches.actorId, actor.id),
        targetColumn(target),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * What an actor watches, newest first, limited to what they can see now:
 * `spaceIds` is the caller's allowlist, `null` for every space.
 */
export async function listWatches(
  workspaceId: string,
  actor: WatchActor,
  spaceIds: readonly string[] | null,
): Promise<WatchRecord[]> {
  const db = getDatabase();
  const mine = and(eq(watches.workspaceId, workspaceId), eq(watches.actorType, actor.type), eq(watches.actorId, actor.id));
  const visible = (spaceId: string) => spaceIds === null || spaceIds.includes(spaceId);

  const [pageRows, spaceRows] = await Promise.all([
    db
      .select({
        id: watches.id,
        pageId: pages.id,
        title: pages.title,
        spaceId: spaces.id,
        spaceKey: spaces.key,
        createdAt: watches.createdAt,
      })
      .from(watches)
      .innerJoin(pages, and(eq(pages.id, watches.pageId), isNull(pages.deletedAt)))
      .innerJoin(spaces, eq(spaces.id, pages.spaceId))
      .where(mine),
    db
      .select({
        id: watches.id,
        spaceId: spaces.id,
        title: spaces.name,
        spaceKey: spaces.key,
        createdAt: watches.createdAt,
      })
      .from(watches)
      .innerJoin(spaces, eq(spaces.id, watches.spaceId))
      .where(mine)
      .orderBy(desc(watches.createdAt)),
  ]);

  return [
    ...pageRows
      .filter((row) => visible(row.spaceId))
      .map((row) => ({
        id: row.id,
        target: { kind: 'page', id: row.pageId } as const,
        title: row.title,
        spaceKey: row.spaceKey,
        createdAt: row.createdAt,
      })),
    ...spaceRows
      .filter((row) => visible(row.spaceId))
      .map((row) => ({
        id: row.id,
        target: { kind: 'space', id: row.spaceId } as const,
        title: row.title,
        spaceKey: row.spaceKey,
        createdAt: row.createdAt,
      })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Finds what a caller asked to watch, refusing a target outside their
 * workspace or sight as "not found". `spaceIds` null means every space.
 */
export async function resolveWatchTarget(
  workspaceId: string,
  spaceIds: readonly string[] | null,
  requested: RequestedWatchTarget,
): Promise<WatchTarget> {
  const db = getDatabase();
  const [row] =
    requested.kind === 'page'
      ? await db
          .select({ id: pages.id, spaceId: pages.spaceId })
          .from(pages)
          .where(and(eq(pages.id, requested.id), eq(pages.workspaceId, workspaceId), isNull(pages.deletedAt)))
          .limit(1)
      : await db
          .select({ id: spaces.id, spaceId: spaces.id })
          .from(spaces)
          .where(and(eq(spaces.key, requested.key), eq(spaces.workspaceId, workspaceId)))
          .limit(1);
  if (!row || (spaceIds !== null && !spaceIds.includes(row.spaceId))) {
    throw new PageServiceError('not_found', requested.kind === 'page' ? 'Page not found' : 'Space not found');
  }
  return { kind: requested.kind, id: row.id };
}
