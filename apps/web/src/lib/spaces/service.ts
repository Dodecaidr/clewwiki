import 'server-only';

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { agentTokens, pages, spaces, users } from '@clewwiki/db';
import type { ActorKind, RepositorySettings, SpaceSettings } from '@clewwiki/db';

import { recordAudit } from '../audit';
import { getDatabase } from '../db';
import type { DbExecutor } from '../db';
import { PageServiceError } from '../pages/errors';
import { isSpaceKey, normalizeSpaceKey } from './keys';

/**
 * The space service.
 *
 * A space is the unit a project lives in: its page tree, its source repository,
 * and the set of pages an agent token can be limited to. As with pages, every
 * function takes the caller's `workspaceId` and puts it in the SQL predicate,
 * so a space belonging to another workspace is invisible rather than forbidden.
 *
 * Creating, changing and archiving a space are administrator acts; the handlers
 * and actions check the role, and every change is audited here.
 */

export interface SpaceActor {
  type: ActorKind;
  id: string;
}

export interface SpaceRecord {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  description: string;
  icon: string | null;
  homePageId: string | null;
  /** The page holding the project's working rules, when one is designated. */
  rulesPageId: string | null;
  settings: SpaceSettings;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

/** The part of a space every page, hit and claim carries with it. */
export interface SpaceRef {
  id: string;
  key: string;
  name: string;
}

export interface SpaceSummary extends SpaceRecord {
  pageCount: number;
  lastUpdatedAt: Date | null;
  /** Who wrote the most recently updated page, with a display name when one resolves. */
  lastUpdatedBy: { type: ActorKind; id: string; name: string | null } | null;
}

const spaceColumns = {
  id: spaces.id,
  workspaceId: spaces.workspaceId,
  key: spaces.key,
  name: spaces.name,
  description: spaces.description,
  icon: spaces.icon,
  homePageId: spaces.homePageId,
  rulesPageId: spaces.rulesPageId,
  settings: spaces.settings,
  createdBy: spaces.createdBy,
  createdAt: spaces.createdAt,
  updatedAt: spaces.updatedAt,
  archivedAt: spaces.archivedAt,
} as const;

const UNIQUE_VIOLATION = '23505';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if (
      typeof current === 'object' &&
      'code' in current &&
      (current as { code?: unknown }).code === UNIQUE_VIOLATION
    ) {
      return true;
    }
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function getSpaceById(
  workspaceId: string,
  spaceId: string,
  executor: DbExecutor = getDatabase(),
): Promise<SpaceRecord | null> {
  const [row] = await executor
    .select(spaceColumns)
    .from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

export async function getSpaceByKey(
  workspaceId: string,
  key: string,
  executor: DbExecutor = getDatabase(),
): Promise<SpaceRecord | null> {
  const normalized = normalizeSpaceKey(key);
  // A string that cannot be a key is not looked up at all.
  if (!isSpaceKey(normalized)) return null;
  const [row] = await executor
    .select(spaceColumns)
    .from(spaces)
    .where(and(eq(spaces.key, normalized), eq(spaces.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

export interface ListSpacesOptions {
  includeArchived?: boolean;
  /** Only these spaces; `null` or omitted means every space in the workspace. */
  spaceIds?: readonly string[] | null;
}

export async function listSpaces(
  workspaceId: string,
  options: ListSpacesOptions = {},
): Promise<SpaceRecord[]> {
  if (options.spaceIds && options.spaceIds.length === 0) return [];
  const db = getDatabase();
  const filters = [eq(spaces.workspaceId, workspaceId)];
  if (!options.includeArchived) filters.push(isNull(spaces.archivedAt));
  if (options.spaceIds) filters.push(inArray(spaces.id, [...options.spaceIds]));

  return db
    .select(spaceColumns)
    .from(spaces)
    .where(and(...filters))
    .orderBy(asc(spaces.name), asc(spaces.key));
}

interface LatestRow extends Record<string, unknown> {
  space_id: string;
  updated_by_type: ActorKind;
  updated_by_id: string;
  updated_at: string | Date;
}

/**
 * Spaces with the numbers the space list shows: how many live pages, when one
 * last changed and who changed it. Three queries whatever the number of spaces,
 * because the home page renders this on every visit.
 */
export async function listSpaceSummaries(
  workspaceId: string,
  options: ListSpacesOptions = {},
): Promise<SpaceSummary[]> {
  const records = await listSpaces(workspaceId, options);
  if (records.length === 0) return [];

  const db = getDatabase();
  const ids = records.map((space) => space.id);

  const counts = await db
    .select({ spaceId: pages.spaceId, count: sql<number>`count(*)::int` })
    .from(pages)
    .where(and(eq(pages.workspaceId, workspaceId), isNull(pages.deletedAt), inArray(pages.spaceId, ids)))
    .groupBy(pages.spaceId);
  const countBySpace = new Map(counts.map((row) => [row.spaceId, row.count]));

  const latestResult = await db.execute<LatestRow>(sql`
    select distinct on (space_id) space_id, updated_by_type, updated_by_id, updated_at
    from pages
    where workspace_id = ${workspaceId}
      and deleted_at is null
      and space_id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    order by space_id, updated_at desc
  `);
  const latestRows = Array.isArray(latestResult) ? (latestResult as LatestRow[]) : [];
  const latestBySpace = new Map(latestRows.map((row) => [row.space_id, row]));

  const userIds = [
    ...new Set(latestRows.filter((row) => row.updated_by_type === 'user').map((row) => row.updated_by_id)),
  ];
  // Token ids are uuids; anything else could not name a token and would only
  // make the lookup fail on the cast.
  const tokenIds = [
    ...new Set(
      latestRows
        .filter((row) => row.updated_by_type === 'agent' && UUID_PATTERN.test(row.updated_by_id))
        .map((row) => row.updated_by_id),
    ),
  ];
  const names = new Map<string, string>();
  if (userIds.length > 0) {
    const rows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, userIds));
    for (const row of rows) names.set(`user:${row.id}`, row.name);
  }
  if (tokenIds.length > 0) {
    const rows = await db
      .select({ id: agentTokens.id, name: agentTokens.name })
      .from(agentTokens)
      .where(and(eq(agentTokens.workspaceId, workspaceId), inArray(agentTokens.id, tokenIds)));
    for (const row of rows) names.set(`agent:${row.id}`, row.name);
  }

  return records.map((space) => {
    const latest = latestBySpace.get(space.id);
    return {
      ...space,
      pageCount: countBySpace.get(space.id) ?? 0,
      lastUpdatedAt: latest
        ? latest.updated_at instanceof Date
          ? latest.updated_at
          : new Date(latest.updated_at)
        : null,
      lastUpdatedBy: latest
        ? {
            type: latest.updated_by_type,
            id: latest.updated_by_id,
            name: names.get(`${latest.updated_by_type}:${latest.updated_by_id}`) ?? null,
          }
        : null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

export interface CreateSpaceInput {
  workspaceId: string;
  actor: SpaceActor;
  key: string;
  name: string;
  description?: string;
  icon?: string | null;
}

export async function createSpace(input: CreateSpaceInput): Promise<SpaceRecord> {
  const key = normalizeSpaceKey(input.key);
  if (!isSpaceKey(key)) {
    throw new PageServiceError('validation', 'A space key is 2 to 10 letters A–Z or digits 0–9');
  }
  const name = input.name.trim();
  if (name.length === 0) throw new PageServiceError('validation', 'A space needs a name');

  const db = getDatabase();
  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(spaces)
        .values({
          workspaceId: input.workspaceId,
          key,
          name,
          description: input.description?.trim() ?? '',
          icon: input.icon?.trim() ? input.icon.trim() : null,
          createdBy: input.actor.type === 'user' ? input.actor.id : null,
        })
        .returning(spaceColumns);
      if (!created) throw new PageServiceError('conflict', 'The space could not be created');

      await recordAudit(
        {
          workspaceId: input.workspaceId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: 'space.created',
          target: created.id,
          metadata: { key: created.key, name: created.name },
        },
        tx,
      );
      return created;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PageServiceError('conflict', `A space with the key ${key} already exists`, { key });
    }
    throw error;
  }
}

export interface UpdateSpaceInput {
  workspaceId: string;
  spaceId: string;
  actor: SpaceActor;
  name?: string;
  description?: string;
  icon?: string | null;
  /** `null` clears the home page. */
  homePageId?: string | null;
  /** `null` clears the rules page. */
  rulesPageId?: string | null;
  /** `null` unlinks the repository. */
  repository?: RepositorySettings | null;
  /**
   * The space's discussion retention policy. Given whole, because the two
   * windows and the decisions page are edited on one form and a half-applied
   * policy is a policy nobody chose.
   */
  discussions?: {
    idleDays: number;
    retentionDays: number;
    /** `null` clears it; the next resolution creates `/decisions` again. */
    decisionsPageId: string | null;
  };
}

/**
 * Changes a space's editable fields. The key is not one of them: it is in every
 * URL and every agent prompt that names the space, and a key that could change
 * would break both silently.
 */
export async function updateSpace(input: UpdateSpaceInput): Promise<SpaceRecord> {
  const db = getDatabase();

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select(spaceColumns)
      .from(spaces)
      .where(and(eq(spaces.id, input.spaceId), eq(spaces.workspaceId, input.workspaceId)))
      .limit(1)
      .for('update');
    if (!current) throw new PageServiceError('not_found', 'Space not found');

    const changes: Partial<typeof spaces.$inferInsert> = {};
    const changed: string[] = [];

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length === 0) throw new PageServiceError('validation', 'A space needs a name');
      changes.name = name;
      changed.push('name');
    }
    if (input.description !== undefined) {
      changes.description = input.description.trim();
      changed.push('description');
    }
    if (input.icon !== undefined) {
      changes.icon = input.icon?.trim() ? input.icon.trim() : null;
      changed.push('icon');
    }
    /** A designated page must be a live page of this space, or nothing at all. */
    const requirePageInSpace = async (pageId: string, label: string) => {
      const [found] = await tx
        .select({ id: pages.id })
        .from(pages)
        .where(
          and(
            eq(pages.id, pageId),
            eq(pages.workspaceId, input.workspaceId),
            eq(pages.spaceId, current.id),
            isNull(pages.deletedAt),
          ),
        )
        .limit(1);
      if (!found) {
        throw new PageServiceError('validation', `The ${label} must be a page in this space`);
      }
    };

    if (input.homePageId !== undefined) {
      if (input.homePageId !== null) await requirePageInSpace(input.homePageId, 'home page');
      changes.homePageId = input.homePageId;
      changed.push('home_page_id');
    }
    if (input.rulesPageId !== undefined) {
      if (input.rulesPageId !== null) await requirePageInSpace(input.rulesPageId, 'rules page');
      changes.rulesPageId = input.rulesPageId;
      changed.push('rules_page_id');
    }
    // Both settings edits write the same JSON column, so they are folded into
    // one object here rather than each overwriting the other's work.
    let settings: SpaceSettings | null = null;
    const repositoryChanged = input.repository !== undefined;
    if (repositoryChanged) {
      settings = { ...current.settings };
      if (input.repository === null) delete settings.repository;
      else if (input.repository) settings.repository = input.repository;
      changed.push('repository');
    }
    if (input.discussions !== undefined) {
      const policy = input.discussions;
      if (policy.decisionsPageId !== null) {
        await requirePageInSpace(policy.decisionsPageId, 'decisions page');
      }
      settings = {
        ...(settings ?? current.settings),
        discussion_idle_days: policy.idleDays,
        discussion_retention_days: policy.retentionDays,
        decisions_page_id: policy.decisionsPageId,
      };
      changed.push('discussions');
    }
    if (settings !== null) changes.settings = settings;

    if (changed.length === 0) return current;

    const now = new Date();
    const [updated] = await tx
      .update(spaces)
      .set({ ...changes, updatedAt: now })
      .where(eq(spaces.id, current.id))
      .returning(spaceColumns);
    if (!updated) throw new PageServiceError('not_found', 'Space not found');

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'space.updated',
        target: updated.id,
        metadata: { key: updated.key, fields: changed },
      },
      tx,
    );

    if (repositoryChanged) {
      await recordAudit(
        {
          workspaceId: input.workspaceId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: 'space.repository_set',
          target: updated.id,
          // The URL and the *name* of the token variable; never a credential.
          metadata: {
            key: updated.key,
            url: input.repository?.url ?? null,
            default_ref: input.repository?.default_ref ?? null,
            auth_token_env: input.repository?.auth_token_env ?? null,
          },
        },
        tx,
      );
    }

    return updated;
  });
}

export interface ArchiveSpaceInput {
  workspaceId: string;
  spaceId: string;
  actor: SpaceActor;
  archived: boolean;
}

/**
 * Archives a space, or brings it back. Idempotent: archiving an archived space
 * answers with the space as it is and writes no second audit row.
 */
export async function setSpaceArchived(input: ArchiveSpaceInput): Promise<SpaceRecord> {
  const db = getDatabase();
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select(spaceColumns)
      .from(spaces)
      .where(and(eq(spaces.id, input.spaceId), eq(spaces.workspaceId, input.workspaceId)))
      .limit(1)
      .for('update');
    if (!current) throw new PageServiceError('not_found', 'Space not found');

    const isArchived = current.archivedAt !== null;
    if (isArchived === input.archived) return current;

    const now = new Date();
    const [updated] = await tx
      .update(spaces)
      .set({ archivedAt: input.archived ? now : null, updatedAt: now })
      .where(eq(spaces.id, current.id))
      .returning(spaceColumns);
    if (!updated) throw new PageServiceError('not_found', 'Space not found');

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: input.archived ? 'space.archived' : 'space.unarchived',
        target: updated.id,
        metadata: { key: updated.key },
      },
      tx,
    );
    return updated;
  });
}
