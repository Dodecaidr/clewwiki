import 'server-only';

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { claims, pageRevisions, pages, spaces } from '@clewwiki/db';
import type { SQL } from 'drizzle-orm';
import type { ActorKind, PageKind } from '@clewwiki/db';

import { computeContentHash } from './content';
import { assertValidContentBlocks } from './content-blocks';
import { PageServiceError, isPageServiceError } from './errors';
import {
  InvalidPathError,
  isDescendantPath,
  joinPath,
  lastSegment,
  likePrefixPattern,
  normalizePath,
  parentPathOf,
} from './paths';
import { generateSegment, withNumericSuffix } from './slug';
import { recordAudit } from '../audit';
import {
  advanceClaimBaseHash,
  releaseClaimsForPages,
  requireClaimForWrite,
} from '../claims/service';
import { getDatabase } from '../db';
import type { DbExecutor, Transaction } from '../db';

/**
 * The page service.
 *
 * Every REST handler and every server component goes through this module, so
 * the rules that matter — workspace scoping, the revision written with each
 * write, the audit row committed in the same transaction as the write it
 * records — exist in exactly one place and cannot be forgotten by one caller.
 *
 * Every function takes the caller's `workspaceId` as its first argument and
 * puts it in the SQL predicate rather than checking it afterwards, so a page
 * belonging to another workspace is invisible rather than merely forbidden.
 *
 * Pages belong to exactly one space, and everything that works on a tree — a
 * path lookup, a move, a subtree delete or restore, a pairing — stays inside
 * the page's space, because the same path can exist once per space. A page is
 * found by id across the workspace; whether the caller may see that page's
 * space is the handler's check, written out next to the workspace check.
 */

export interface PageActor {
  type: ActorKind;
  id: string;
}

export interface PageRecord {
  id: string;
  workspaceId: string;
  spaceId: string;
  parentId: string | null;
  path: string;
  title: string;
  kind: PageKind;
  linkedPageId: string | null;
  body: string;
  summary: string | null;
  contentHash: string;
  version: number;
  createdByType: ActorKind;
  createdById: string;
  updatedByType: ActorKind;
  updatedById: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * Explicit column list: `search_vector` is maintained by PostgreSQL and is
 * large, and nothing outside the search query has any use for it.
 */
const pageColumns = {
  id: pages.id,
  workspaceId: pages.workspaceId,
  spaceId: pages.spaceId,
  parentId: pages.parentId,
  path: pages.path,
  title: pages.title,
  kind: pages.kind,
  linkedPageId: pages.linkedPageId,
  body: pages.body,
  summary: pages.summary,
  contentHash: pages.contentHash,
  version: pages.version,
  createdByType: pages.createdByType,
  createdById: pages.createdById,
  updatedByType: pages.updatedByType,
  updatedById: pages.updatedById,
  createdAt: pages.createdAt,
  updatedAt: pages.updatedAt,
  deletedAt: pages.deletedAt,
} as const;

const UNIQUE_VIOLATION = '23505';

/**
 * Recognises a unique-constraint violation.
 *
 * The driver's error is wrapped by the query layer, so the SQLSTATE code sits
 * on the cause rather than on the error handed to us — checking only the outer
 * error turns "this path is taken" into an opaque 500.
 */
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

/** Turns a path rejection into the validation error the API answers with. */
function toServiceError(error: unknown): Error {
  if (error instanceof InvalidPathError) {
    return new PageServiceError('validation', error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function getPageById(
  workspaceId: string,
  pageId: string,
  executor: DbExecutor = getDatabase(),
): Promise<PageRecord | null> {
  const [row] = await executor
    .select(pageColumns)
    .from(pages)
    .where(
      and(eq(pages.id, pageId), eq(pages.workspaceId, workspaceId), isNull(pages.deletedAt)),
    )
    .limit(1);
  return row ?? null;
}

export async function getPageByPath(
  workspaceId: string,
  spaceId: string,
  path: string,
  executor: DbExecutor = getDatabase(),
): Promise<PageRecord | null> {
  let normalized: string;
  try {
    normalized = normalizePath(path);
  } catch (error) {
    throw toServiceError(error);
  }

  const [row] = await executor
    .select(pageColumns)
    .from(pages)
    .where(
      and(
        eq(pages.path, normalized),
        eq(pages.workspaceId, workspaceId),
        eq(pages.spaceId, spaceId),
        isNull(pages.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The space a page belongs to, deleted or not. Handlers that reach a page
 * through something else — a claim, an anchor — use it to apply the space
 * check to the page behind the resource.
 */
export async function getPageSpaceId(
  workspaceId: string,
  pageId: string,
  executor: DbExecutor = getDatabase(),
): Promise<string | null> {
  const [row] = await executor
    .select({ spaceId: pages.spaceId })
    .from(pages)
    .where(and(eq(pages.id, pageId), eq(pages.workspaceId, workspaceId)))
    .limit(1);
  return row?.spaceId ?? null;
}

/**
 * The live pages above `page`, root first. One query over the path prefixes,
 * for breadcrumbs.
 */
export async function getAncestors(
  workspaceId: string,
  page: Pick<PageRecord, 'spaceId' | 'path'>,
): Promise<Array<Pick<PageRecord, 'id' | 'title' | 'path'>>> {
  const prefixes: string[] = [];
  let current = parentPathOf(page.path);
  while (current !== null) {
    prefixes.push(current);
    current = parentPathOf(current);
  }
  if (prefixes.length === 0) return [];

  const db = getDatabase();
  const rows = await db
    .select({ id: pages.id, title: pages.title, path: pages.path })
    .from(pages)
    .where(
      and(
        eq(pages.workspaceId, workspaceId),
        eq(pages.spaceId, page.spaceId),
        isNull(pages.deletedAt),
        inArray(pages.path, prefixes),
      ),
    );
  return rows.sort((a, b) => a.path.length - b.path.length);
}

/** Loads a page or fails with the `not_found` the handlers hand straight back. */
export async function requirePage(
  workspaceId: string,
  pageId: string,
  executor: DbExecutor = getDatabase(),
): Promise<PageRecord> {
  const page = await getPageById(workspaceId, pageId, executor);
  if (!page) {
    throw new PageServiceError('not_found', 'Page not found');
  }
  return page;
}

export interface ListPagesOptions {
  /** Only pages in this space. */
  spaceId?: string;
  /** Only pages in these spaces; an empty list matches nothing. */
  spaceIds?: readonly string[];
  /** `null` lists the roots; omit to list every page. */
  parentId?: string | null;
  kind?: PageKind;
  limit?: number;
  /** Path order (the default, a parent before its children) or newest first. */
  orderBy?: 'path' | 'updated';
}

export async function listPages(
  workspaceId: string,
  options: ListPagesOptions = {},
): Promise<PageRecord[]> {
  if (options.spaceIds && options.spaceIds.length === 0) return [];
  const db = getDatabase();
  const filters = [eq(pages.workspaceId, workspaceId), isNull(pages.deletedAt)];

  if (options.spaceId) filters.push(eq(pages.spaceId, options.spaceId));
  if (options.spaceIds) filters.push(inArray(pages.spaceId, [...options.spaceIds]));
  if (options.parentId === null) {
    filters.push(isNull(pages.parentId));
  } else if (typeof options.parentId === 'string') {
    filters.push(eq(pages.parentId, options.parentId));
  }
  if (options.kind) {
    filters.push(eq(pages.kind, options.kind));
  }

  return db
    .select(pageColumns)
    .from(pages)
    .where(and(...filters))
    .orderBy(options.orderBy === 'updated' ? desc(pages.updatedAt) : asc(pages.path))
    .limit(options.limit ?? 500);
}

export interface PageTreeNode {
  id: string;
  spaceId: string;
  parentId: string | null;
  path: string;
  title: string;
  kind: PageKind;
  updatedAt: Date;
  children: PageTreeNode[];
}

/**
 * The page tree of one space.
 *
 * One flat query plus an in-memory assembly, not a recursive CTE: a space holds
 * a few hundred pages at most, and the flat read is also what the sidebar
 * needs. Ordering by path means a parent is always seen before its children, so
 * a single pass builds the nesting.
 */
export async function getPageTree(
  workspaceId: string,
  spaceId: string,
  rootId: string | null = null,
): Promise<PageTreeNode[]> {
  const db = getDatabase();

  if (rootId !== null) {
    // Resolved through the workspace predicate, so asking for the subtree of
    // another workspace's page is a 404 rather than an empty answer.
    const root = await requirePage(workspaceId, rootId);
    if (root.spaceId !== spaceId) {
      throw new PageServiceError('not_found', 'Page not found');
    }
  }

  const rows = await db
    .select({
      id: pages.id,
      spaceId: pages.spaceId,
      parentId: pages.parentId,
      path: pages.path,
      title: pages.title,
      kind: pages.kind,
      updatedAt: pages.updatedAt,
    })
    .from(pages)
    .where(
      and(eq(pages.workspaceId, workspaceId), eq(pages.spaceId, spaceId), isNull(pages.deletedAt)),
    )
    .orderBy(asc(pages.path));

  const byId = new Map<string, PageTreeNode>();
  for (const row of rows) {
    byId.set(row.id, { ...row, children: [] });
  }

  const roots: PageTreeNode[] = [];
  for (const row of rows) {
    const node = byId.get(row.id);
    if (!node) continue;
    const parent = row.parentId ? byId.get(row.parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  if (rootId === null) return roots;

  // A subtree request answers with the requested page at its head, so the
  // caller can tell "has no children" apart from "does not exist".
  const root = byId.get(rootId);
  return root ? [root] : [];
}

export async function listRevisions(
  workspaceId: string,
  pageId: string,
  limit = 100,
): Promise<
  Array<{
    version: number;
    title: string;
    summary: string | null;
    contentHash: string;
    authorType: ActorKind;
    authorId: string;
    createdAt: Date;
  }>
> {
  // The page is resolved through the workspace predicate first: revisions are
  // only reachable through a page the caller is allowed to see.
  await requirePage(workspaceId, pageId);
  const db = getDatabase();

  return db
    .select({
      version: pageRevisions.version,
      title: pageRevisions.title,
      summary: pageRevisions.summary,
      contentHash: pageRevisions.contentHash,
      authorType: pageRevisions.authorType,
      authorId: pageRevisions.authorId,
      createdAt: pageRevisions.createdAt,
    })
    .from(pageRevisions)
    .where(eq(pageRevisions.pageId, pageId))
    .orderBy(desc(pageRevisions.version))
    .limit(limit);
}

export interface RevisionRecord {
  pageId: string;
  version: number;
  title: string;
  body: string;
  summary: string | null;
  contentHash: string;
  authorType: ActorKind;
  authorId: string;
  createdAt: Date;
}

/**
 * One version of a page, body included, or null when the page never had it.
 *
 * Reachable only through a page the caller may see, like the listing above.
 */
export async function getRevision(
  workspaceId: string,
  pageId: string,
  version: number,
  executor: DbExecutor = getDatabase(),
): Promise<RevisionRecord | null> {
  await requirePage(workspaceId, pageId, executor);
  const [row] = await executor
    .select({
      pageId: pageRevisions.pageId,
      version: pageRevisions.version,
      title: pageRevisions.title,
      body: pageRevisions.body,
      summary: pageRevisions.summary,
      contentHash: pageRevisions.contentHash,
      authorType: pageRevisions.authorType,
      authorId: pageRevisions.authorId,
      createdAt: pageRevisions.createdAt,
    })
    .from(pageRevisions)
    .where(and(eq(pageRevisions.pageId, pageId), eq(pageRevisions.version, version)))
    .limit(1);
  return row ?? null;
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

export interface CreatePageInput {
  /**
   * The id the page is created with, when the caller needs to know it in
   * advance. Only the import pipeline uses it: a batch of pages that link to
   * each other has to resolve those links before the first body is written, and
   * it cannot do that without knowing where the pages will be. Everything else
   * leaves it out and lets PostgreSQL generate one.
   */
  id?: string;
  workspaceId: string;
  /** The space the page is created in. Parents are looked up inside it. */
  spaceId: string;
  actor: PageActor;
  title: string;
  body?: string;
  summary?: string | null;
  kind?: PageKind;
  parentId?: string | null;
  /** The parent by its path in the same space. Exclusive with `parentId`. */
  parentPath?: string;
  /** Explicit path. With a parent, only its last segment is used. */
  path?: string;
  /** Explicit last segment, joined onto the parent's path. Exclusive with `path`. */
  slug?: string;
  /**
   * A page of the other kind in the same space to pair the new page with, in
   * the transaction that creates it.
   */
  linkToPageId?: string | null;
}

/** Where a new page goes, before its segment is known to be free. */
interface CreationTarget {
  parentId: string | null;
  /**
   * The path as asked for. When `generated` is true it came from the title,
   * and the service may append `-2`, `-3`, … to its last segment.
   */
  path: string;
  parentPath: string | null;
  segment: string;
  generated: boolean;
}

/** How many numbered segments are tried before a generated path gives up. */
const MAX_GENERATED_SUFFIX = 200;
/** How many times an insert is retried after losing a race for a generated path. */
const GENERATED_PATH_ATTEMPTS = 5;

async function resolveCreationTarget(
  workspaceId: string,
  input: CreatePageInput,
): Promise<CreationTarget> {
  if (typeof input.parentId === 'string' && input.parentPath !== undefined) {
    throw new PageServiceError('validation', 'Give parent_id or parent_path, not both');
  }
  if (input.path !== undefined && input.slug !== undefined) {
    throw new PageServiceError('validation', 'Give path or slug, not both');
  }

  try {
    let parent: PageRecord | null = null;
    if (typeof input.parentId === 'string') {
      parent = await requirePage(workspaceId, input.parentId);
      if (parent.spaceId !== input.spaceId) {
        // Answered as "not found" rather than "in another space", so the refusal
        // says nothing about a space the caller may not be able to see.
        throw new PageServiceError('not_found', 'Parent page not found');
      }
    } else if (input.parentPath !== undefined) {
      parent = await getPageByPath(workspaceId, input.spaceId, input.parentPath);
      if (!parent) {
        throw new PageServiceError('not_found', 'Parent page not found', {
          parent_path: input.parentPath,
        });
      }
    }

    if (input.path !== undefined) {
      const normalized = normalizePath(input.path);
      if (parent) {
        // With both a parent and a path, the parent wins on placement and the
        // path contributes only its last segment. The two cannot disagree.
        const segment = lastSegment(normalized);
        return {
          path: joinPath(parent.path, segment),
          parentId: parent.id,
          parentPath: parent.path,
          segment,
          generated: false,
        };
      }
      // Without an explicit parent, the path decides: attach to whatever page
      // already occupies the path above, if any.
      const parentPath = parentPathOf(normalized);
      const implied = parentPath
        ? await getPageByPath(workspaceId, input.spaceId, parentPath)
        : null;
      return {
        path: normalized,
        parentId: implied?.id ?? null,
        parentPath,
        segment: lastSegment(normalized),
        generated: false,
      };
    }

    const parentPath = parent?.path ?? null;
    if (input.slug !== undefined) {
      const path = joinPath(parentPath, input.slug);
      return {
        path,
        parentId: parent?.id ?? null,
        parentPath,
        segment: lastSegment(path),
        generated: false,
      };
    }

    const segment = generateSegment(input.title);
    return {
      path: joinPath(parentPath, segment),
      parentId: parent?.id ?? null,
      parentPath,
      segment,
      generated: true,
    };
  } catch (error) {
    throw toServiceError(error);
  }
}

/**
 * The first of `segment`, `segment-2`, `segment-3`, … that no live page in the
 * space occupies under `parentPath`. Candidates are looked up a batch at a
 * time, so a title used a hundred times costs a few queries rather than a
 * hundred.
 */
async function firstFreeGeneratedPath(
  workspaceId: string,
  spaceId: string,
  parentPath: string | null,
  segment: string,
): Promise<string> {
  const db = getDatabase();
  const batch = 25;
  for (let from = 1; from <= MAX_GENERATED_SUFFIX; from += batch) {
    const candidates: string[] = [];
    for (let n = from; n < from + batch && n <= MAX_GENERATED_SUFFIX; n += 1) {
      try {
        candidates.push(joinPath(parentPath, withNumericSuffix(segment, n)));
      } catch (error) {
        throw toServiceError(error);
      }
    }
    const taken = await db
      .select({ path: pages.path })
      .from(pages)
      .where(
        and(
          eq(pages.workspaceId, workspaceId),
          eq(pages.spaceId, spaceId),
          isNull(pages.deletedAt),
          inArray(pages.path, candidates),
        ),
      );
    const occupied = new Set(taken.map((row) => row.path));
    const free = candidates.find((candidate) => !occupied.has(candidate));
    if (free !== undefined) return free;
  }
  throw new PageServiceError(
    'conflict',
    `Every numbered variant of ${segment} is taken here; choose a slug explicitly`,
    { segment },
  );
}

export async function createPage(input: CreatePageInput): Promise<PageRecord> {
  const title = input.title.trim();
  if (title.length === 0) {
    throw new PageServiceError('validation', 'Title must not be empty');
  }
  // Chart and diagram blocks are checked before anything is looked up, so a
  // body that cannot be stored costs no queries.
  assertValidContentBlocks(input.body ?? '');

  const db = getDatabase();
  const [space] = await db
    .select({ id: spaces.id, key: spaces.key, archivedAt: spaces.archivedAt })
    .from(spaces)
    .where(and(eq(spaces.id, input.spaceId), eq(spaces.workspaceId, input.workspaceId)))
    .limit(1);
  if (!space) {
    throw new PageServiceError('not_found', 'Space not found');
  }
  if (space.archivedAt !== null) {
    throw new PageServiceError('conflict', 'This space is archived and takes no new pages', {
      space: space.key,
    });
  }

  const target = await resolveCreationTarget(input.workspaceId, { ...input, title });
  const body = input.body ?? '';
  const contentHash = computeContentHash(body);
  const linkToPageId = input.linkToPageId ?? null;

  const insert = (path: string) =>
    db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(pages)
        .values({
          ...(input.id === undefined ? {} : { id: input.id }),
          workspaceId: input.workspaceId,
          spaceId: space.id,
          parentId: target.parentId,
          path,
          title,
          kind: input.kind ?? 'technical',
          body,
          summary: input.summary ?? null,
          contentHash,
          version: 1,
          createdByType: input.actor.type,
          createdById: input.actor.id,
          updatedByType: input.actor.type,
          updatedById: input.actor.id,
        })
        .returning(pageColumns);

      if (!inserted) {
        throw new PageServiceError('conflict', 'Page could not be created');
      }

      await tx.insert(pageRevisions).values({
        pageId: inserted.id,
        version: 1,
        title: inserted.title,
        body: inserted.body,
        summary: inserted.summary,
        contentHash: inserted.contentHash,
        authorType: input.actor.type,
        authorId: input.actor.id,
      });

      await recordAudit(
        {
          workspaceId: input.workspaceId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: 'page.created',
          target: inserted.id,
          metadata: { space: space.key, path: inserted.path, kind: inserted.kind, version: 1 },
        },
        tx,
      );

      if (linkToPageId === null) return inserted;

      // Paired in the same transaction: a failed pairing — a counterpart of the
      // same kind, or one that is not there — leaves no half-made page behind.
      const linked = await linkPagesWithin(tx, {
        workspaceId: input.workspaceId,
        pageId: inserted.id,
        linkedPageId: linkToPageId,
        actor: input.actor,
      });
      return { ...inserted, linkedPageId: linked.linkedPageId };
    });

  if (!target.generated) {
    try {
      return await insert(target.path);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await getPageByPath(input.workspaceId, space.id, target.path);
        throw new PageServiceError(
          'conflict',
          `A page already exists at ${target.path} in this space`,
          {
            path: target.path,
            space: space.key,
            ...(existing ? { existing_page_id: existing.id } : {}),
          },
        );
      }
      throw error;
    }
  }

  // A generated path is the title's, not the caller's choice, so a taken one is
  // numbered rather than refused. Two creations racing for the same number end
  // with one unique violation, and the loser simply looks again.
  for (let attempt = 1; ; attempt += 1) {
    const path = await firstFreeGeneratedPath(
      input.workspaceId,
      space.id,
      target.parentPath,
      target.segment,
    );
    try {
      return await insert(path);
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= GENERATED_PATH_ATTEMPTS) {
        if (isUniqueViolation(error)) {
          throw new PageServiceError('conflict', `A page already exists at ${path} in this space`, {
            path,
            space: space.key,
          });
        }
        throw error;
      }
    }
  }
}

export interface UpdatePageInput {
  workspaceId: string;
  pageId: string;
  actor: PageActor;
  title?: string;
  body?: string;
  summary?: string | null;
  kind?: PageKind;
  parentId?: string | null;
  path?: string;
  /**
   * The claim the caller writes under. Mandatory: a write to a page nobody
   * holds is the lost update this product exists to prevent, so there is no
   * path through this function without a lease.
   */
  claimId: string;
  /**
   * The hash the caller last read. It must still match, so a write built on
   * content someone else has since replaced is refused rather than silently
   * winning — the claim says nobody else may write, the hash says nobody did.
   */
  baseContentHash: string;
  /**
   * Who holds `claimId`, when that is not the author. A live editing session
   * holds one claim for everybody in it, under an identity of its own, and the
   * person who saves is still the author of the revision. Nothing reachable
   * from a request sets this: a handler passes the caller as `actor` and the
   * claim is checked against the caller.
   */
  claimActor?: PageActor;
}

/**
 * Writes a page under a claim.
 *
 * Both halves of the protocol are checked inside the transaction that holds the
 * page row locked: the lease (held by this caller, not expired, covering this
 * page) and the base hash. A failed attempt is audited too — on its own
 * connection, since the transaction that would have carried the row is the one
 * being rolled back.
 */
export async function updatePage(input: UpdatePageInput): Promise<PageRecord> {
  try {
    return await runUpdatePage(input);
  } catch (error) {
    if (isPageServiceError(error)) {
      try {
        await recordAudit({
          workspaceId: input.workspaceId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: 'page.write_rejected',
          target: input.pageId,
          metadata: {
            result: 'rejected',
            reason: error.code,
            claimId: input.claimId,
            ...(error.details ?? {}),
          },
        });
      } catch (auditError) {
        console.error('[pages] rejected write could not be audited', auditError);
      }
    }
    throw error;
  }
}

async function runUpdatePage(input: UpdatePageInput): Promise<PageRecord> {
  const db = getDatabase();

  return db.transaction(async (tx) => {
    // The row is locked for the duration of the transaction, so two writers
    // cannot both read version N and both write version N+1.
    const [current] = await tx
      .select(pageColumns)
      .from(pages)
      .where(
        and(
          eq(pages.id, input.pageId),
          eq(pages.workspaceId, input.workspaceId),
          isNull(pages.deletedAt),
        ),
      )
      .limit(1)
      .for('update');

    if (!current) {
      throw new PageServiceError('not_found', 'Page not found');
    }

    // The lease is checked before the hash, and both before anything is
    // written: a caller with no claim is told that first, rather than being
    // told its content is stale when its real problem is that it never had
    // permission to write at all.
    const claim = await requireClaimForWrite({
      tx,
      workspaceId: input.workspaceId,
      pageId: current.id,
      claimId: input.claimId,
      actor: input.claimActor ?? input.actor,
    });

    if (input.baseContentHash !== current.contentHash) {
      throw new PageServiceError('stale_base', 'Page has changed since it was read', {
        current_content_hash: current.contentHash,
        your_base_hash: input.baseContentHash,
      });
    }

    const title = input.title === undefined ? current.title : input.title.trim();
    if (title.length === 0) {
      throw new PageServiceError('validation', 'Title must not be empty');
    }

    const body = input.body ?? current.body;
    // Only a body that changes is checked. A page stored before a rule existed
    // must still accept a rename or a move without first being rewritten.
    if (body !== current.body) {
      assertValidContentBlocks(body);
    }
    const summary = input.summary === undefined ? current.summary : input.summary;
    const kind = input.kind ?? current.kind;
    const contentHash = computeContentHash(body);

    const { path, parentId } = await resolveMoveTarget(tx, current, input);
    const moved = path !== current.path;

    const version = current.version + 1;
    const now = new Date();

    const [updated] = await tx
      .update(pages)
      .set({
        title,
        body,
        summary,
        kind,
        path,
        parentId,
        contentHash,
        version,
        updatedByType: input.actor.type,
        updatedById: input.actor.id,
        updatedAt: now,
      })
      .where(eq(pages.id, current.id))
      .returning(pageColumns);

    if (!updated) {
      throw new PageServiceError('not_found', 'Page not found');
    }

    if (moved) {
      // Descendants carry the materialised path of their ancestor, so a move
      // rewrites the whole subtree — in this transaction, never as a follow-up
      // that could be interrupted half way.
      // Written as SQL rather than through the query builder: the assignment
      // targets of an UPDATE are bare column names, which the builder cannot
      // express alongside an expression that reads the same column.
      // Every placeholder is cast: the statement is sent with unspecified
      // parameter types, and PostgreSQL cannot infer them from `||` or from
      // `substring(... from ...)` on its own.
      await tx.execute(sql`
        update pages
        set path = ${path}::text || substring(path from ${current.path.length + 1}::int),
            updated_at = ${now.toISOString()}::timestamptz
        where workspace_id = ${input.workspaceId}::uuid
          and space_id = ${current.spaceId}::uuid
          and deleted_at is null
          and path like ${likePrefixPattern(current.path)}::text escape '\\'
      `);
    }

    await tx.insert(pageRevisions).values({
      pageId: updated.id,
      version,
      title: updated.title,
      body: updated.body,
      summary: updated.summary,
      contentHash: updated.contentHash,
      authorType: input.actor.type,
      authorId: input.actor.id,
    });

    // The holder's own write is not an intervening edit, so the lease moves to
    // the hash it just produced: a second write under the same claim would
    // otherwise be refused as stale against the first.
    await advanceClaimBaseHash(tx, claim.id, updated.contentHash);

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'page.updated',
        target: updated.id,
        metadata: {
          version,
          path: updated.path,
          moved,
          result: 'success',
          claimId: claim.id,
          sectionId: claim.sectionId,
          previousPath: moved ? current.path : undefined,
          previousContentHash: current.contentHash,
        },
      },
      tx,
    );

    return updated;
  });
}

async function resolveMoveTarget(
  tx: DbExecutor,
  current: PageRecord,
  input: UpdatePageInput,
): Promise<{ path: string; parentId: string | null }> {
  if (input.parentId === undefined && input.path === undefined) {
    return { path: current.path, parentId: current.parentId };
  }

  const loadPage = async (predicate: SQL | undefined) => {
    const [row] = await tx.select(pageColumns).from(pages).where(predicate).limit(1);
    return row ?? null;
  };

  let target: { path: string; parentId: string | null };

  try {
    if (input.parentId === undefined && input.path !== undefined) {
      // A path on its own is authoritative: it places the page, and the page
      // already sitting above it becomes the parent.
      const normalized = normalizePath(input.path);
      const parentPath = parentPathOf(normalized);
      const implied = parentPath
        ? await loadPage(
            and(
              eq(pages.path, parentPath),
              eq(pages.workspaceId, current.workspaceId),
              eq(pages.spaceId, current.spaceId),
              isNull(pages.deletedAt),
            ),
          )
        : null;
      target = { path: normalized, parentId: implied?.id ?? null };
    } else {
      let parentPath: string | null = null;
      let parentId: string | null = null;

      if (typeof input.parentId === 'string') {
        if (input.parentId === current.id) {
          throw new PageServiceError('validation', 'A page cannot be its own parent');
        }
        const parent = await loadPage(
          and(
            eq(pages.id, input.parentId),
            eq(pages.workspaceId, current.workspaceId),
            // A page moves inside its space only.
            eq(pages.spaceId, current.spaceId),
            isNull(pages.deletedAt),
          ),
        );
        if (!parent) {
          throw new PageServiceError('not_found', 'Parent page not found');
        }
        parentId = parent.id;
        parentPath = parent.path;
      }

      const segment =
        input.path === undefined
          ? lastSegment(current.path)
          : lastSegment(normalizePath(input.path));
      target = { path: joinPath(parentPath, segment), parentId };
    }
  } catch (error) {
    throw toServiceError(error);
  }

  if (target.parentId === current.id || isDescendantPath(target.path, current.path)) {
    throw new PageServiceError('validation', 'A page cannot be moved below itself');
  }
  return target;
}

export interface DeletePageInput {
  workspaceId: string;
  pageId: string;
  actor: PageActor;
  /**
   * True only for a human workspace administrator. It is what lets a delete go
   * ahead over other actors' live claims in the subtree, releasing them.
   */
  overrideClaims?: boolean;
}

/**
 * Soft-deletes a page and everything below it.
 *
 * The rows stay so their revision history survives; only `deleted_at` is set,
 * which is also what frees the path for reuse, because the uniqueness index
 * covers live rows only. The paired counterpart is unlinked in the same
 * transaction so the pair never points at a deleted page from one side.
 *
 * Someone else's live claim anywhere in the subtree refuses the delete with
 * `conflict`, naming the claims: a lease means somebody is in the middle of
 * writing there, and removing the page under them is the lost update claims
 * exist to prevent. The caller's own claims do not count. A human
 * administrator may override, which releases those claims as `forced`. A
 * refusal is audited as `page.delete_rejected`.
 */
export async function deletePage(input: DeletePageInput): Promise<{ deleted: number }> {
  const db = getDatabase();

  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx
        .select(pageColumns)
        .from(pages)
        .where(
          and(
            eq(pages.id, input.pageId),
            eq(pages.workspaceId, input.workspaceId),
            isNull(pages.deletedAt),
          ),
        )
        .limit(1)
        .for('update');

      if (!current) {
        throw new PageServiceError('not_found', 'Page not found');
      }

      const now = new Date();
      // The same path exists once per space, so the subtree is the prefix match
      // inside the page's own space and nowhere else.
      const subtree = sql`(${pages.spaceId} = ${current.spaceId} and (${pages.id} = ${current.id} or ${pages.path} like ${likePrefixPattern(current.path)} escape '\\'))`;

      if (!input.overrideClaims) {
        const held = await tx
          .select({
            claimId: claims.id,
            pageId: claims.pageId,
            holderType: claims.holderType,
            holderId: claims.holderId,
            holderLabel: claims.holderLabel,
            expiresAt: claims.expiresAt,
          })
          .from(claims)
          .innerJoin(pages, eq(pages.id, claims.pageId))
          .where(
            and(
              eq(claims.workspaceId, input.workspaceId),
              eq(pages.workspaceId, input.workspaceId),
              isNull(pages.deletedAt),
              isNull(claims.releasedAt),
              gt(claims.expiresAt, now),
              subtree,
            ),
          );

        const others = held.filter(
          (claim) => claim.holderType !== input.actor.type || claim.holderId !== input.actor.id,
        );
        if (others.length > 0) {
          throw new PageServiceError(
            'conflict',
            'Another actor holds a claim on this page or below it; only an administrator can delete it now',
            {
              claims: others.map((claim) => ({
                claim_id: claim.claimId,
                page_id: claim.pageId,
                held_by: claim.holderLabel,
                actor_type: claim.holderType,
                expires_at: claim.expiresAt.toISOString(),
              })),
            },
          );
        }
      }

      const removed = await tx
        .update(pages)
        .set({ deletedAt: now, linkedPageId: null, updatedAt: now })
        .where(and(eq(pages.workspaceId, input.workspaceId), isNull(pages.deletedAt), subtree))
        .returning({ id: pages.id });

      const removedIds = removed.map((row) => row.id);
      if (removedIds.length > 0) {
        await tx
          .update(pages)
          .set({ linkedPageId: null, updatedAt: now })
          .where(
            and(
              eq(pages.workspaceId, input.workspaceId),
              inArray(pages.linkedPageId, removedIds),
            ),
          );
      }

      // A claim on a page that no longer exists would sit in the presence board
      // until its TTL ran out, naming a page nobody can open.
      const releasedClaims = await releaseClaimsForPages(
        tx,
        input.workspaceId,
        removedIds,
        input.actor,
        now,
      );

      await recordAudit(
        {
          workspaceId: input.workspaceId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: 'page.deleted',
          target: current.id,
          metadata: {
            path: current.path,
            descendants: removedIds.length - 1,
            claimsReleased: releasedClaims,
            // The deletion timestamp is what a restore matches the subtree on.
            deletedAt: now.toISOString(),
          },
        },
        tx,
      );

      return { deleted: removedIds.length };
    });
  } catch (error) {
    if (isPageServiceError(error) && error.code === 'conflict') {
      try {
        await recordAudit({
          workspaceId: input.workspaceId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: 'page.delete_rejected',
          target: input.pageId,
          metadata: { result: 'rejected', reason: error.code, ...(error.details ?? {}) },
        });
      } catch (auditError) {
        console.error('[pages] delete refusal could not be audited', auditError);
      }
    }
    throw error;
  }
}

export interface RestorePageInput {
  workspaceId: string;
  pageId: string;
  actor: PageActor;
}

/**
 * Brings a soft-deleted page back, with the subtree that was deleted with it.
 *
 * "With it" is exact: the rows restored are the page and the rows below its
 * path that carry the same `deleted_at`, i.e. that went in the same delete. A
 * child deleted separately earlier stays deleted.
 *
 * It is refused with `conflict` rather than guessed at when the tree has moved
 * on: a live page now occupies one of the paths, the parent is itself deleted,
 * or the parent has since moved so the old path no longer sits under it. Links
 * to a counterpart were cleared by the delete and are not re-created; pairing
 * again is an explicit act.
 */
export async function restorePage(input: RestorePageInput): Promise<{ restored: number; path: string }> {
  const db = getDatabase();

  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx
        .select(pageColumns)
        .from(pages)
        .where(and(eq(pages.id, input.pageId), eq(pages.workspaceId, input.workspaceId)))
        .limit(1)
        .for('update');

      if (!current) throw new PageServiceError('not_found', 'Page not found');
      if (current.deletedAt === null) {
        throw new PageServiceError('conflict', 'Page is not deleted');
      }

      if (current.parentId !== null) {
        const [parent] = await tx
          .select({ id: pages.id, path: pages.path, deletedAt: pages.deletedAt })
          .from(pages)
          .where(and(eq(pages.id, current.parentId), eq(pages.workspaceId, input.workspaceId)))
          .limit(1)
          .for('update');
        if (!parent || parent.deletedAt !== null) {
          throw new PageServiceError('conflict', 'The parent page is deleted; restore it first', {
            parent_id: current.parentId,
          });
        }
        if (parentPathOf(current.path) !== parent.path) {
          throw new PageServiceError(
            'conflict',
            'The parent page has moved since this page was deleted',
            { parent_id: parent.id, parent_path: parent.path, path: current.path },
          );
        }
      }

      const subtree = await tx
        .select({ id: pages.id, path: pages.path })
        .from(pages)
        .where(
          and(
            eq(pages.workspaceId, input.workspaceId),
            eq(pages.spaceId, current.spaceId),
            eq(pages.deletedAt, current.deletedAt),
            sql`(${pages.id} = ${current.id} or ${pages.path} like ${likePrefixPattern(current.path)} escape '\\')`,
          ),
        );

      const paths = subtree.map((row) => row.path);
      const occupied = await tx
        .select({ path: pages.path })
        .from(pages)
        .where(
          and(
            eq(pages.workspaceId, input.workspaceId),
            eq(pages.spaceId, current.spaceId),
            isNull(pages.deletedAt),
            inArray(pages.path, paths),
          ),
        );
      if (occupied.length > 0) {
        throw new PageServiceError('conflict', 'A live page already exists at a path being restored', {
          paths: occupied.map((row) => row.path),
        });
      }

      const now = new Date();
      const restored = await tx
        .update(pages)
        .set({ deletedAt: null, updatedAt: now })
        .where(
          and(
            eq(pages.workspaceId, input.workspaceId),
            isNotNull(pages.deletedAt),
            inArray(
              pages.id,
              subtree.map((row) => row.id),
            ),
          ),
        )
        .returning({ id: pages.id });

      await recordAudit(
        {
          workspaceId: input.workspaceId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: 'page.restored',
          target: current.id,
          metadata: { path: current.path, descendants: restored.length - 1 },
        },
        tx,
      );

      return { restored: restored.length, path: current.path };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PageServiceError('conflict', 'A live page already exists at a path being restored');
    }
    throw error;
  }
}

export interface LinkPagesInput {
  workspaceId: string;
  pageId: string;
  /** `null` breaks the pair from either side. */
  linkedPageId: string | null;
  actor: PageActor;
}

/**
 * Pairs a technical page with its human counterpart, or unpairs them.
 *
 * Both rows are written together: a pair that only one side knows about is the
 * bug this function exists to make impossible. Relinking a page that was
 * already paired also clears the abandoned partner.
 */
export async function linkPages(
  input: LinkPagesInput,
): Promise<{ pageId: string; linkedPageId: string | null }> {
  return getDatabase().transaction((tx) => linkPagesWithin(tx, input));
}

/** `linkPages` inside a transaction the caller already holds. */
async function linkPagesWithin(
  tx: Transaction,
  input: LinkPagesInput,
): Promise<{ pageId: string; linkedPageId: string | null }> {
  const [page] = await tx
    .select(pageColumns)
    .from(pages)
    .where(
      and(
        eq(pages.id, input.pageId),
        eq(pages.workspaceId, input.workspaceId),
        isNull(pages.deletedAt),
      ),
    )
    .limit(1)
    .for('update');

  if (!page) {
    throw new PageServiceError('not_found', 'Page not found');
  }

  const now = new Date();

  const clearPartner = async (partnerId: string | null) => {
    if (!partnerId || partnerId === input.linkedPageId) return;
    await tx
      .update(pages)
      .set({ linkedPageId: null, updatedAt: now })
      .where(and(eq(pages.id, partnerId), eq(pages.workspaceId, input.workspaceId)));
  };

  if (input.linkedPageId === null) {
    await clearPartner(page.linkedPageId);
    await tx
      .update(pages)
      .set({ linkedPageId: null, updatedAt: now })
      .where(eq(pages.id, page.id));

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'page.unlinked',
        target: page.id,
        metadata: { previousLinkedPageId: page.linkedPageId },
      },
      tx,
    );
    return { pageId: page.id, linkedPageId: null };
  }

  if (input.linkedPageId === page.id) {
    throw new PageServiceError('validation', 'A page cannot be linked to itself');
  }

  const [counterpart] = await tx
    .select(pageColumns)
    .from(pages)
    .where(
      and(
        eq(pages.id, input.linkedPageId),
        eq(pages.workspaceId, input.workspaceId),
        // A pair lives in one space: the technical and the human page of
        // one subject belong to the same project.
        eq(pages.spaceId, page.spaceId),
        isNull(pages.deletedAt),
      ),
    )
    .limit(1)
    .for('update');

  if (!counterpart) {
    throw new PageServiceError('not_found', 'Page not found');
  }
  if (counterpart.kind === page.kind) {
    throw new PageServiceError(
      'validation',
      'A pair must join one technical page with one human page',
      { kind: page.kind },
    );
  }

  await clearPartner(page.linkedPageId);
  await clearPartner(counterpart.linkedPageId);

  await tx
    .update(pages)
    .set({ linkedPageId: counterpart.id, updatedAt: now })
    .where(eq(pages.id, page.id));
  await tx
    .update(pages)
    .set({ linkedPageId: page.id, updatedAt: now })
    .where(eq(pages.id, counterpart.id));

  await recordAudit(
    {
      workspaceId: input.workspaceId,
      actorType: input.actor.type,
      actorId: input.actor.id,
      action: 'page.linked',
      target: page.id,
      metadata: { linkedPageId: counterpart.id },
    },
    tx,
  );

  return { pageId: page.id, linkedPageId: counterpart.id };
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

export interface SearchOptions {
  query: string;
  /**
   * The spaces to search. Always explicit: the handler decides what "all
   * spaces" means for its caller — every visible, unarchived space — and an
   * empty list finds nothing.
   */
  spaceIds: readonly string[];
  limit?: number;
  kind?: PageKind;
}

export interface SearchHit {
  pageId: string;
  spaceId: string;
  spaceKey: string;
  spaceName: string;
  path: string;
  title: string;
  kind: PageKind;
  snippet: string;
  contentHash: string;
  updatedAt: Date;
}

const HEADLINE_OPTIONS =
  'StartSel=[[,StopSel=]],MaxWords=32,MinWords=12,MaxFragments=2,FragmentDelimiter= … ';

/** Strips the headline markers, so a snippet is plain text and never markup. */
function plainSnippet(value: string): string {
  return value.replaceAll('[[', '').replaceAll(']]', '').trim();
}

interface SearchRow extends Record<string, unknown> {
  id: string;
  space_id: string;
  space_key: string;
  space_name: string;
  path: string;
  title: string;
  kind: PageKind;
  content_hash: string;
  updated_at: string | Date;
  snippet: string;
}

/**
 * Builds a prefix query from the caller's words: `auth to` becomes
 * `auth:* & to:*`. It is the fallback for a partial word, which
 * `plainto_tsquery` cannot match because it compares whole lexemes.
 */
function toPrefixQuery(query: string): string | null {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0)
    .slice(0, 8);
  if (terms.length === 0) return null;
  return terms.map((term) => `${term}:*`).join(' & ');
}

/**
 * Full-text search over title, summary and body, ranked, scoped to one
 * workspace and to the spaces the caller names. Nothing here reaches outside
 * PostgreSQL: at one-workspace scale a separate search service would be a
 * dependency bought for nothing.
 */
export async function searchPages(
  workspaceId: string,
  options: SearchOptions,
): Promise<SearchHit[]> {
  const query = options.query.trim();
  if (query.length === 0 || options.spaceIds.length === 0) return [];
  const spaceFilter = sql.join(
    options.spaceIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const db = getDatabase();

  const run = async (tsquery: SQL): Promise<SearchHit[]> => {
    const kindFilter = options.kind ? sql`and p.kind = ${options.kind}::page_kind` : sql``;
    const result = await db.execute<SearchRow>(sql`
      select p.id,
             p.space_id,
             s.key as space_key,
             s.name as space_name,
             p.path,
             p.title,
             p.kind,
             p.content_hash,
             p.updated_at,
             ts_headline(
               'english',
               coalesce(p.summary, '') || ' ' || p.body,
               q.query,
               ${HEADLINE_OPTIONS}
             ) as snippet
      from pages p
      join spaces s on s.id = p.space_id and s.workspace_id = p.workspace_id,
      ${tsquery} as q(query)
      where p.workspace_id = ${workspaceId}
        and p.space_id in (${spaceFilter})
        and p.deleted_at is null
        and p.search_vector @@ q.query
        ${kindFilter}
      order by ts_rank_cd(p.search_vector, q.query) desc, p.updated_at desc
      limit ${limit}
    `);

    const rows = Array.isArray(result) ? (result as SearchRow[]) : [];
    return rows.map((row) => ({
      pageId: row.id,
      spaceId: row.space_id,
      spaceKey: row.space_key,
      spaceName: row.space_name,
      path: row.path,
      title: row.title,
      kind: row.kind,
      snippet: plainSnippet(row.snippet ?? ''),
      contentHash: row.content_hash,
      updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
    }));
  };

  const direct = await run(sql`plainto_tsquery('english', ${query})`);
  if (direct.length > 0) return direct;

  // Nothing matched whole words. Retry treating the last characters of each
  // word as a prefix, which is what makes a half-typed query find a page.
  const prefix = toPrefixQuery(query);
  if (prefix === null) return [];
  return run(sql`to_tsquery('english', ${prefix})`);
}
