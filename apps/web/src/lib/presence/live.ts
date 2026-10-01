import 'server-only';

import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { agentTokens, auditLog, pages, presenceHeartbeats, spaces, users } from '@clewwiki/db';

import { getDatabase } from '../db';

/**
 * Who is in the wiki right now — not who holds a claim, but who has it open.
 *
 * People report themselves: an open page sends a heartbeat every half minute
 * while its tab is visible (`components/presence-heartbeat.tsx`). Agents do
 * not have to: every request an agent token makes is audited as `api.request`
 * with its route, so the last few minutes of the log say which agents are
 * working and on which page.
 */

/** A person whose tab has not reported for this long has left. */
export const PERSON_WINDOW_MS = 2 * 60 * 1000;
/** An agent is "working" while its token made a request this recently. */
export const AGENT_WINDOW_MS = 10 * 60 * 1000;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PAGE_ROUTE = new RegExp(`^/api/v1/pages/(${UUID})(?:/|$)`, 'i');

export function pageIdOfRoute(route: string | null): string | null {
  if (!route) return null;
  return PAGE_ROUTE.exec(route)?.[1]?.toLowerCase() ?? null;
}

export async function recordHeartbeat(input: {
  workspaceId: string;
  userId: string;
  pageId: string | null;
  mode: 'viewing' | 'editing';
  automated: boolean;
  now?: Date;
}): Promise<void> {
  const seenAt = input.now ?? new Date();
  await getDatabase()
    .insert(presenceHeartbeats)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      pageId: input.pageId,
      mode: input.mode,
      automated: input.automated,
      seenAt,
    })
    .onConflictDoUpdate({
      target: [presenceHeartbeats.workspaceId, presenceHeartbeats.userId],
      set: { pageId: input.pageId, mode: input.mode, automated: input.automated, seenAt },
    });
}

export interface LivePerson {
  userId: string;
  name: string;
  mode: 'viewing' | 'editing';
  automated: boolean;
  seenAt: Date;
  page: LivePage | null;
}

export interface LiveAgent {
  tokenId: string;
  name: string;
  lastSeen: Date;
  requests: number;
  method: string | null;
  page: LivePage | null;
}

export interface LivePage {
  id: string;
  title: string;
  spaceKey: string;
}

/**
 * Everybody active in the organization, people and agents. A page is named
 * only when the viewer may see its space; somebody on a page the viewer cannot
 * see is still listed, without saying where.
 */
export async function getLivePresence(input: {
  workspaceId: string;
  /** Spaces the viewer may see, or `null` for all. */
  spaceIds: string[] | null;
  now?: Date;
}): Promise<{ people: LivePerson[]; agents: LiveAgent[] }> {
  const db = getDatabase();
  const now = input.now ?? new Date();

  const peopleRows = await db
    .select({
      userId: presenceHeartbeats.userId,
      name: users.name,
      mode: presenceHeartbeats.mode,
      automated: presenceHeartbeats.automated,
      seenAt: presenceHeartbeats.seenAt,
      pageId: presenceHeartbeats.pageId,
    })
    .from(presenceHeartbeats)
    .innerJoin(users, eq(users.id, presenceHeartbeats.userId))
    .where(
      and(
        eq(presenceHeartbeats.workspaceId, input.workspaceId),
        gt(presenceHeartbeats.seenAt, new Date(now.getTime() - PERSON_WINDOW_MS)),
      ),
    )
    .orderBy(desc(presenceHeartbeats.seenAt));

  // The latest request of each agent token in the window, and how many it made.
  const since = new Date(now.getTime() - AGENT_WINDOW_MS);
  const agentRows = await db
    .select({
      tokenId: auditLog.actorId,
      lastSeen: sql<Date>`max(${auditLog.createdAt})`.mapWith((value: string | Date) => new Date(value)),
      requests: sql<number>`count(*)`.mapWith(Number),
      lastRoute: sql<string | null>`(array_agg(${auditLog.target} order by ${auditLog.createdAt} desc))[1]`,
      lastMethod: sql<string | null>`(array_agg(${auditLog.metadata}->>'method' order by ${auditLog.createdAt} desc))[1]`,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.workspaceId, input.workspaceId),
        eq(auditLog.actorType, 'agent'),
        eq(auditLog.action, 'api.request'),
        gt(auditLog.createdAt, since),
      ),
    )
    .groupBy(auditLog.actorId);

  const tokenIds = agentRows.map((row) => row.tokenId);
  const tokenNames = new Map(
    tokenIds.length === 0
      ? []
      : (
          await db
            .select({ id: agentTokens.id, name: agentTokens.name })
            .from(agentTokens)
            .where(and(eq(agentTokens.workspaceId, input.workspaceId), inArray(sql`${agentTokens.id}::text`, tokenIds)))
        ).map((row) => [row.id, row.name]),
  );

  const pageIds = [
    ...new Set(
      [...peopleRows.map((row) => row.pageId), ...agentRows.map((row) => pageIdOfRoute(row.lastRoute))].filter(
        (id): id is string => id !== null,
      ),
    ),
  ];
  const pageRows =
    pageIds.length === 0
      ? []
      : await db
          .select({ id: pages.id, title: pages.title, spaceId: pages.spaceId, spaceKey: spaces.key })
          .from(pages)
          .innerJoin(spaces, eq(spaces.id, pages.spaceId))
          .where(and(eq(pages.workspaceId, input.workspaceId), inArray(pages.id, pageIds)));
  const visible = new Map(
    pageRows
      .filter((row) => input.spaceIds === null || input.spaceIds.includes(row.spaceId))
      .map((row) => [row.id, { id: row.id, title: row.title, spaceKey: row.spaceKey }]),
  );

  return {
    people: peopleRows.map((row) => ({
      userId: row.userId,
      name: row.name,
      mode: row.mode,
      automated: row.automated,
      seenAt: row.seenAt,
      page: row.pageId ? (visible.get(row.pageId) ?? null) : null,
    })),
    agents: agentRows
      .map((row) => {
        const pageId = pageIdOfRoute(row.lastRoute);
        return {
          tokenId: row.tokenId,
          name: tokenNames.get(row.tokenId) ?? '—',
          lastSeen: row.lastSeen,
          requests: row.requests,
          method: row.lastMethod,
          page: pageId ? (visible.get(pageId) ?? null) : null,
        };
      })
      .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime()),
  };
}
