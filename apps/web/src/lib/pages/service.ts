import 'server-only';

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { pageRevisions, pages } from '@clewwiki/db';
import type { SQL } from 'drizzle-orm';
import type { ActorKind, PageKind } from '@clewwiki/db';

import { computeContentHash } from './content';
import { PageServiceError } from './errors';
import {
  InvalidPathError,
  isDescendantPath,
  joinPath,
  lastSegment,
  likePrefixPattern,
  normalizePath,
  parentPathOf,
  slugifySegment,
} from './paths';
import { recordAudit } from '../audit';
import { getDatabase } from '../db';
import type { DbExecutor } from '../db';

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
 */

export interface PageActor {
  type: ActorKind;
  id: string;
}

export interface PageRecord {
  id: string;
  workspaceId: string;
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
      and(eq(pages.path, normalized), eq(pages.workspaceId, workspaceId), isNull(pages.deletedAt)),
    )
    .limit(1);
  return row ?? null;
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
  /** `null` lists the roots; omit to list the whole workspace. */
  parentId?: string | null;
  kind?: PageKind;
  limit?: number;
}

export async function listPages(
  workspaceId: string,
  options: ListPagesOptions = {},
): Promise<PageRecord[]> {
  const db = getDatabase();
  const filters = [eq(pages.workspaceId, workspaceId), isNull(pages.deletedAt)];

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
    .orderBy(asc(pages.path))
    .limit(options.limit ?? 500);
}

export interface PageTreeNode {
  id: string;
  parentId: string | null;
  path: string;
  title: string;
  kind: PageKind;
  updatedAt: Date;
  children: PageTreeNode[];
}

/**
 * The page tree.
 *
 * One flat query plus an in-memory assembly, not a recursive CTE: a v1
 * workspace holds a few hundred pages at most, and the flat read is also what
 * the sidebar needs. Ordering by path means a parent is always seen before its
 * children, so a single pass builds the nesting.
 */
export async function getPageTree(
  workspaceId: string,
  rootId: string | null = null,
): Promise<PageTreeNode[]> {
  const db = getDatabase();

  if (rootId !== null) {
    // Resolved through the workspace predicate, so asking for the subtree of
    // another workspace's page is a 404 rather than an empty answer.
    await requirePage(workspaceId, rootId);
  }

  const rows = await db
    .select({
      id: pages.id,
      parentId: pages.parentId,
      path: pages.path,
      title: pages.title,
      kind: pages.kind,
      updatedAt: pages.updatedAt,
    })
    .from(pages)
    .where(and(eq(pages.workspaceId, workspaceId), isNull(pages.deletedAt)))
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

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

export interface CreatePageInput {
  workspaceId: string;
  actor: PageActor;
  title: string;
  body?: string;
  summary?: string | null;
  kind?: PageKind;
  parentId?: string | null;
  /** Explicit path. Derived from the title and the parent when omitted. */
  path?: string;
}

async function resolveCreationPath(
  workspaceId: string,
  input: CreatePageInput,
): Promise<{ path: string; parentId: string | null }> {
  const parent =
    typeof input.parentId === 'string' ? await requirePage(workspaceId, input.parentId) : null;

  try {
    if (input.path) {
      const normalized = normalizePath(input.path);
      if (parent) {
        // With both a parent and a path, the parent wins on placement and the
        // path contributes only its last segment. The two cannot disagree.
        return { path: joinPath(parent.path, lastSegment(normalized)), parentId: parent.id };
      }
      // Without an explicit parent, the path decides: attach to whatever page
      // already occupies the path above, if any.
      const parentPath = parentPathOf(normalized);
      const implied = parentPath ? await getPageByPath(workspaceId, parentPath) : null;
      return { path: normalized, parentId: implied?.id ?? null };
    }

    const slug = slugifySegment(input.title);
    if (slug.length === 0) {
      throw new PageServiceError(
        'validation',
        'A path could not be derived from the title; supply one explicitly',
      );
    }
    return {
      path: joinPath(parent?.path ?? null, slug),
      parentId: parent?.id ?? null,
    };
  } catch (error) {
    throw toServiceError(error);
  }
}

export async function createPage(input: CreatePageInput): Promise<PageRecord> {
  const title = input.title.trim();
  if (title.length === 0) {
    throw new PageServiceError('validation', 'Title must not be empty');
  }

  const { path, parentId } = await resolveCreationPath(input.workspaceId, input);
  const body = input.body ?? '';
  const contentHash = computeContentHash(body);
  const db = getDatabase();

  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(pages)
        .values({
          workspaceId: input.workspaceId,
          parentId,
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

      if (!created) {
        throw new PageServiceError('conflict', 'Page could not be created');
      }

      await tx.insert(pageRevisions).values({
        pageId: created.id,
        version: 1,
        title: created.title,
        body: created.body,
        summary: created.summary,
        contentHash: created.contentHash,
        authorType: input.actor.type,
        authorId: input.actor.id,
      });

      await recordAudit(
        {
          workspaceId: input.workspaceId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: 'page.created',
          target: created.id,
          metadata: { path: created.path, kind: created.kind, version: 1 },
        },
        tx,
      );

      return created;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PageServiceError('conflict', `A page already exists at ${path}`, { path });
    }
    throw error;
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
   * The hash the caller last read. When supplied it must still match, so a
   * write built on content someone else has since replaced is refused rather
   * than silently winning. Phase 3 makes it mandatory alongside a claim.
   */
  baseContentHash?: string;
}

export async function updatePage(input: UpdatePageInput): Promise<PageRecord> {
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

    if (input.baseContentHash !== undefined && input.baseContentHash !== current.contentHash) {
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
}

/**
 * Soft-deletes a page and everything below it.
 *
 * The rows stay so their revision history survives; only `deleted_at` is set,
 * which is also what frees the path for reuse, because the uniqueness index
 * covers live rows only. The paired counterpart is unlinked in the same
 * transaction so the pair never points at a deleted page from one side.
 */
export async function deletePage(input: DeletePageInput): Promise<{ deleted: number }> {
  const db = getDatabase();

  return db.transaction(async (tx) => {
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
    const removed = await tx
      .update(pages)
      .set({ deletedAt: now, linkedPageId: null, updatedAt: now })
      .where(
        and(
          eq(pages.workspaceId, input.workspaceId),
          isNull(pages.deletedAt),
          sql`(${pages.id} = ${current.id} or ${pages.path} like ${likePrefixPattern(current.path)} escape '\\')`,
        ),
      )
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

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'page.deleted',
        target: current.id,
        metadata: { path: current.path, descendants: removedIds.length - 1 },
      },
      tx,
    );

    return { deleted: removedIds.length };
  });
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
  const db = getDatabase();

  return db.transaction(async (tx) => {
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
  });
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

export interface SearchOptions {
  query: string;
  limit?: number;
  kind?: PageKind;
}

export interface SearchHit {
  pageId: string;
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
 * Full-text search over title, summary and body, ranked and scoped to one
 * workspace. Nothing here reaches outside PostgreSQL: at one-workspace scale a
 * separate search service would be a dependency bought for nothing.
 */
export async function searchPages(
  workspaceId: string,
  options: SearchOptions,
): Promise<SearchHit[]> {
  const query = options.query.trim();
  if (query.length === 0) return [];

  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const db = getDatabase();

  const run = async (tsquery: SQL): Promise<SearchHit[]> => {
    const kindFilter = options.kind ? sql`and p.kind = ${options.kind}::page_kind` : sql``;
    const result = await db.execute<SearchRow>(sql`
      select p.id,
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
      from pages p, ${tsquery} as q(query)
      where p.workspace_id = ${workspaceId}
        and p.deleted_at is null
        and p.search_vector @@ q.query
        ${kindFilter}
      order by ts_rank_cd(p.search_vector, q.query) desc, p.updated_at desc
      limit ${limit}
    `);

    const rows = Array.isArray(result) ? (result as SearchRow[]) : [];
    return rows.map((row) => ({
      pageId: row.id,
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
