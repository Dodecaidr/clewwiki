import 'server-only';

import { asc, count, eq } from 'drizzle-orm';
import { memberships, workspaces } from '@clewwiki/db';

import { recordAudit } from '../audit';
import { getDatabase } from '../db';
import { isInstanceAdmin } from '../workspace';

/**
 * Organizations. Each one is a workspace — its own members, spaces, agent
 * tokens, administrators and settings — and every query in the application is
 * already scoped to one, so an organization is isolated by the same predicate
 * that scoped the single workspace before.
 *
 * One account may belong to several; which one a request works in is chosen
 * with `ORG_COOKIE` (see `lib/workspace.ts`). Only an instance administrator
 * creates organizations, and becomes the first administrator of each one they
 * create; from there the organization's own administrators invite people.
 */

export type OrgErrorCode = 'forbidden' | 'name' | 'slug' | 'slugTaken';

export class OrgError extends Error {
  constructor(readonly code: OrgErrorCode) {
    super(code);
    this.name = 'OrgError';
  }
}

/** Lower-case letters, digits and single hyphens; it appears in `/o/<slug>`. */
const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,39}$/;
/** Words the address space of the application already uses or will. */
const RESERVED = new Set(['new', 'admin', 'api', 'login', 'register', 'settings']);

export function normalizeOrgSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  if (!SLUG.test(slug) || RESERVED.has(slug)) throw new OrgError('slug');
  return slug;
}

export function normalizeOrgName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name === '' || name.length > 80) throw new OrgError('name');
  return name;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  memberCount: number;
  createdAt: Date;
}

/** Every organization on the instance, for its administrators only. */
export async function listAllOrganizations(requesterId: string): Promise<OrganizationSummary[]> {
  if (!(await isInstanceAdmin(requesterId))) throw new OrgError('forbidden');
  const db = getDatabase();
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      createdAt: workspaces.createdAt,
      memberCount: count(memberships.id),
    })
    .from(workspaces)
    .leftJoin(memberships, eq(memberships.workspaceId, workspaces.id))
    .groupBy(workspaces.id)
    .orderBy(asc(workspaces.createdAt));
  return rows.map((row) => ({ ...row, memberCount: Number(row.memberCount) }));
}

export async function createOrganization(input: {
  creatorId: string;
  name: string;
  slug: string;
}): Promise<{ id: string; slug: string }> {
  if (!(await isInstanceAdmin(input.creatorId))) throw new OrgError('forbidden');
  const name = normalizeOrgName(input.name);
  const slug = normalizeOrgSlug(input.slug);

  return getDatabase().transaction(async (tx) => {
    const [created] = await tx
      .insert(workspaces)
      .values({ name, slug })
      .onConflictDoNothing({ target: workspaces.slug })
      .returning({ id: workspaces.id, slug: workspaces.slug });
    if (!created) throw new OrgError('slugTaken');
    await tx.insert(memberships).values({ workspaceId: created.id, userId: input.creatorId, role: 'admin' });
    await recordAudit(
      {
        workspaceId: created.id,
        actorType: 'user',
        actorId: input.creatorId,
        action: 'workspace.created',
        target: created.id,
        metadata: { name, slug },
      },
      tx,
    );
    return created;
  });
}
