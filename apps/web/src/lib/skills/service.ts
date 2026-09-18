import 'server-only';

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { skills } from '@clewwiki/db';
import type { ActorKind } from '@clewwiki/db';

import { recordAudit } from '../audit';
import { getDatabase } from '../db';
import { PageServiceError } from '../pages/errors';
import { generateSegment, withNumericSuffix } from '../pages/slug';
import { assertSkillSlug, normalizeSkillInput } from './validate';

/**
 * The skills service.
 *
 * A skill belongs to one space of one workspace, and every function here takes
 * both and puts them in the SQL predicate, so a skill in another space is
 * invisible rather than forbidden — the rule pages follow. Writes are audited
 * in the transaction that performs them (`skill.created`, `skill.updated`,
 * `skill.deleted`), so the log and the table cannot disagree.
 *
 * Deletion is soft, like a page's: the row stays, `deleted_at` is set, and the
 * partial unique index on `(space_id, slug)` covers live rows only, which is
 * what lets a slug be used again afterwards.
 */

export interface SkillActor {
  type: ActorKind;
  id: string;
}

export interface SkillRecord {
  id: string;
  workspaceId: string;
  spaceId: string;
  slug: string;
  name: string;
  description: string;
  body: string;
  version: string | null;
  tags: string[];
  createdByType: ActorKind;
  createdById: string;
  updatedByType: ActorKind;
  updatedById: string;
  createdAt: Date;
  updatedAt: Date;
}

const skillColumns = {
  id: skills.id,
  workspaceId: skills.workspaceId,
  spaceId: skills.spaceId,
  slug: skills.slug,
  name: skills.name,
  description: skills.description,
  body: skills.body,
  version: skills.version,
  tags: skills.tags,
  createdByType: skills.createdByType,
  createdById: skills.createdById,
  updatedByType: skills.updatedByType,
  updatedById: skills.updatedById,
  createdAt: skills.createdAt,
  updatedAt: skills.updatedAt,
} as const;

const UNIQUE_VIOLATION = '23505';

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

export interface ListSkillsOptions {
  /** Only skills carrying this tag. */
  tag?: string;
  limit?: number;
}

/** How many skills one listing ever returns. */
export const MAX_SKILLS_PER_LISTING = 500;

export async function listSkills(
  workspaceId: string,
  spaceId: string,
  options: ListSkillsOptions = {},
): Promise<SkillRecord[]> {
  const db = getDatabase();
  const filters = [
    eq(skills.workspaceId, workspaceId),
    eq(skills.spaceId, spaceId),
    isNull(skills.deletedAt),
  ];
  if (options.tag !== undefined && options.tag.trim() !== '') {
    const tag = options.tag.trim().toLowerCase();
    filters.push(sql`${skills.tags} @> ARRAY[${tag}]::text[]`);
  }

  return db
    .select(skillColumns)
    .from(skills)
    .where(and(...filters))
    .orderBy(asc(skills.name), asc(skills.slug))
    .limit(Math.min(Math.max(options.limit ?? MAX_SKILLS_PER_LISTING, 1), MAX_SKILLS_PER_LISTING));
}

export async function getSkillBySlug(
  workspaceId: string,
  spaceId: string,
  slug: string,
): Promise<SkillRecord | null> {
  const value = slug.trim().toLowerCase();
  const db = getDatabase();
  const [row] = await db
    .select(skillColumns)
    .from(skills)
    .where(
      and(
        eq(skills.workspaceId, workspaceId),
        eq(skills.spaceId, spaceId),
        eq(skills.slug, value),
        isNull(skills.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Every tag in use in a space, most used first — what the filter offers. */
export async function listSkillTags(workspaceId: string, spaceId: string): Promise<string[]> {
  const db = getDatabase();
  const rows = await db
    .select({ tag: sql<string>`tag`, count: sql<number>`count(*)::int` })
    .from(sql`(select unnest(${skills.tags}) as tag from ${skills}
      where ${skills.workspaceId} = ${workspaceId}
        and ${skills.spaceId} = ${spaceId}
        and ${skills.deletedAt} is null) as tags`)
    .groupBy(sql`tag`)
    .orderBy(desc(sql`count(*)`), asc(sql`tag`));
  return rows.map((row) => row.tag);
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

export interface CreateSkillInput {
  workspaceId: string;
  spaceId: string;
  spaceKey: string;
  actor: SkillActor;
  name?: string;
  description?: string;
  version?: string | null;
  tags?: readonly string[];
  body?: string;
  /** The slug to use. Omit to generate it from the name and number it if taken. */
  slug?: string;
}

/** How many numbered slugs are tried before a generated one gives up. */
const MAX_GENERATED_SUFFIX = 200;

export async function createSkill(input: CreateSkillInput): Promise<SkillRecord> {
  const normalized = normalizeSkillInput(
    {
      name: input.name,
      description: input.description,
      version: input.version,
      tags: input.tags,
      body: input.body ?? '',
    },
    { partial: false },
  );
  const name = normalized.name as string;
  const description = normalized.description as string;

  const explicitSlug = input.slug !== undefined && input.slug.trim() !== '';
  const base = explicitSlug ? assertSkillSlug(input.slug as string) : generateSegment(name);

  const db = getDatabase();

  const insert = async (slug: string): Promise<SkillRecord> =>
    db.transaction(async (tx) => {
      const [created] = await tx
        .insert(skills)
        .values({
          workspaceId: input.workspaceId,
          spaceId: input.spaceId,
          slug,
          name,
          description,
          body: normalized.body ?? '',
          version: normalized.version ?? null,
          tags: normalized.tags ?? [],
          createdByType: input.actor.type,
          createdById: input.actor.id,
          updatedByType: input.actor.type,
          updatedById: input.actor.id,
        })
        .returning(skillColumns);
      if (!created) throw new PageServiceError('conflict', 'The skill could not be created');

      await recordAudit(
        {
          workspaceId: input.workspaceId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: 'skill.created',
          target: created.id,
          metadata: { space: input.spaceKey, slug: created.slug, name: created.name },
        },
        tx,
      );
      return created;
    });

  // An explicit slug that is taken is a conflict the caller has to resolve; a
  // generated one is numbered, so creating two skills with the same name works.
  if (explicitSlug) {
    try {
      return await insert(base);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new PageServiceError('conflict', `A skill with the slug ${base} already exists in this space`, {
          slug: base,
          space: input.spaceKey,
        });
      }
      throw error;
    }
  }

  for (let attempt = 1; attempt <= MAX_GENERATED_SUFFIX; attempt += 1) {
    const slug = withNumericSuffix(base, attempt);
    try {
      return await insert(slug);
    } catch (error) {
      if (isUniqueViolation(error)) continue;
      throw error;
    }
  }
  throw new PageServiceError(
    'conflict',
    `Every numbered variant of ${base} is taken here; choose a slug explicitly`,
    { slug: base },
  );
}

export interface UpdateSkillInput {
  workspaceId: string;
  spaceId: string;
  spaceKey: string;
  slug: string;
  actor: SkillActor;
  name?: string;
  description?: string;
  version?: string | null;
  tags?: readonly string[];
  body?: string;
  /** A new slug. The old one becomes free at once, like a moved page's path. */
  newSlug?: string;
}

export async function updateSkill(input: UpdateSkillInput): Promise<SkillRecord> {
  const normalized = normalizeSkillInput(
    {
      name: input.name,
      description: input.description,
      version: input.version,
      tags: input.tags,
      body: input.body,
    },
    { partial: true },
  );
  const newSlug = input.newSlug !== undefined ? assertSkillSlug(input.newSlug) : undefined;

  const db = getDatabase();
  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx
        .select(skillColumns)
        .from(skills)
        .where(
          and(
            eq(skills.workspaceId, input.workspaceId),
            eq(skills.spaceId, input.spaceId),
            eq(skills.slug, input.slug.trim().toLowerCase()),
            isNull(skills.deletedAt),
          ),
        )
        .limit(1)
        .for('update');
      if (!current) throw new PageServiceError('not_found', 'Skill not found');

      const changes: Partial<typeof skills.$inferInsert> = {};
      const changed: string[] = [];
      if (normalized.name !== undefined && normalized.name !== current.name) {
        changes.name = normalized.name;
        changed.push('name');
      }
      if (normalized.description !== undefined && normalized.description !== current.description) {
        changes.description = normalized.description;
        changed.push('description');
      }
      if (normalized.version !== undefined && normalized.version !== current.version) {
        changes.version = normalized.version;
        changed.push('version');
      }
      if (
        normalized.tags !== undefined &&
        normalized.tags.join(' ') !== current.tags.join(' ')
      ) {
        changes.tags = normalized.tags;
        changed.push('tags');
      }
      if (normalized.body !== undefined && normalized.body !== current.body) {
        changes.body = normalized.body;
        changed.push('body');
      }
      if (newSlug !== undefined && newSlug !== current.slug) {
        changes.slug = newSlug;
        changed.push('slug');
      }

      if (changed.length === 0) return current;

      const [updated] = await tx
        .update(skills)
        .set({
          ...changes,
          updatedByType: input.actor.type,
          updatedById: input.actor.id,
          updatedAt: new Date(),
        })
        .where(eq(skills.id, current.id))
        .returning(skillColumns);
      if (!updated) throw new PageServiceError('not_found', 'Skill not found');

      await recordAudit(
        {
          workspaceId: input.workspaceId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: 'skill.updated',
          target: updated.id,
          metadata: { space: input.spaceKey, slug: updated.slug, fields: changed },
        },
        tx,
      );
      return updated;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PageServiceError('conflict', `A skill with the slug ${newSlug} already exists in this space`, {
        slug: newSlug,
        space: input.spaceKey,
      });
    }
    throw error;
  }
}

export interface DeleteSkillInput {
  workspaceId: string;
  spaceId: string;
  spaceKey: string;
  slug: string;
  actor: SkillActor;
}

export async function deleteSkill(input: DeleteSkillInput): Promise<{ slug: string }> {
  const db = getDatabase();
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: skills.id, slug: skills.slug, name: skills.name })
      .from(skills)
      .where(
        and(
          eq(skills.workspaceId, input.workspaceId),
          eq(skills.spaceId, input.spaceId),
          eq(skills.slug, input.slug.trim().toLowerCase()),
          isNull(skills.deletedAt),
        ),
      )
      .limit(1)
      .for('update');
    if (!current) throw new PageServiceError('not_found', 'Skill not found');

    await tx
      .update(skills)
      .set({ deletedAt: new Date(), updatedByType: input.actor.type, updatedById: input.actor.id })
      .where(eq(skills.id, current.id));

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'skill.deleted',
        target: current.id,
        metadata: { space: input.spaceKey, slug: current.slug, name: current.name },
      },
      tx,
    );
    return { slug: current.slug };
  });
}
