import 'server-only';

import { randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { importItems, imports, pages, spaces } from '@clewwiki/db';
import type { ImportDecisionValue, ImportSourceValue, ImportStatusValue } from '@clewwiki/db';
import { DEFAULT_IMPORT_LIMITS, isImportError, placeNodes, rewriteLinks } from '@clewwiki/import';
import type { ImportLimits, ImportParseResult, ImportWarning } from '@clewwiki/import';
import { InvalidPathError, normalizePath } from '@clewwiki/content/paths';

import { recordAudit } from '../audit';
import { acquireClaim, getActiveClaimsForPage, releaseClaim } from '../claims/service';
import { getDatabase } from '../db';
import { getImportMaxExpandedMb, getImportMaxUploadMb } from '../env';
import { PageServiceError, isPageServiceError } from '../pages/errors';
import { createPage, updatePage } from '../pages/service';
import { spacePageHref } from '../spaces/urls';

/**
 * The import service.
 *
 * One rule shapes everything here: an import is staged, never applied on
 * arrival. Parsing a Confluence space, a Notion export or — especially — a PDF
 * produces a guess about what the structure was, and a guess must not become
 * somebody's wiki unread. So `createImport` writes rows to `import_items` and
 * stops at `needs_review`; `applyImport` is a separate, deliberate call that a
 * person makes after looking at the tree, the target paths and the warnings.
 *
 * Two more rules follow from the rest of the product.
 *
 * *Claims are respected.* A page somebody else is holding is skipped with a
 * reason, never overwritten. An import is a bulk write, which is exactly the
 * situation claims exist for, and "I was importing" is not a reason to take a
 * lease away from the person editing.
 *
 * *Only people import.* Every function takes a user actor. An agent token
 * cannot reach these endpoints at all — see `docs/security.md` — because the
 * review step is the safety property and a token cannot perform it.
 */

export interface ImportActor {
  /** Always a person: agent tokens cannot import. */
  type: 'user';
  id: string;
}

export interface ImportRecord {
  id: string;
  workspaceId: string;
  spaceId: string;
  source: ImportSourceValue;
  status: ImportStatusValue;
  createdBy: string | null;
  params: Record<string, unknown>;
  stats: Record<string, unknown>;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ImportItemRecord {
  id: string;
  importId: string;
  sourceId: string;
  title: string;
  targetPath: string;
  parentSourceId: string | null;
  markdown: string;
  warnings: ImportWarning[];
  decision: ImportDecisionValue;
  createdPageId: string | null;
  ordering: number;
}

const importColumns = {
  id: imports.id,
  workspaceId: imports.workspaceId,
  spaceId: imports.spaceId,
  source: imports.source,
  status: imports.status,
  createdBy: imports.createdBy,
  params: imports.params,
  stats: imports.stats,
  error: imports.error,
  createdAt: imports.createdAt,
  updatedAt: imports.updatedAt,
} as const;

const itemColumns = {
  id: importItems.id,
  importId: importItems.importId,
  sourceId: importItems.sourceId,
  title: importItems.title,
  targetPath: importItems.targetPath,
  parentSourceId: importItems.parentSourceId,
  markdown: importItems.markdown,
  warnings: importItems.warnings,
  decision: importItems.decision,
  createdPageId: importItems.createdPageId,
  ordering: importItems.ordering,
} as const;

/** How many imports one space may keep staged at once. */
export const MAX_OPEN_IMPORTS_PER_SPACE = 10;

export function importLimits(): ImportLimits {
  return {
    ...DEFAULT_IMPORT_LIMITS,
    uploadBytes: getImportMaxUploadMb() * 1024 * 1024,
    expandedBytes: getImportMaxExpandedMb() * 1024 * 1024,
  };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function getImport(workspaceId: string, importId: string): Promise<ImportRecord | null> {
  const db = getDatabase();
  const [row] = await db
    .select(importColumns)
    .from(imports)
    .where(and(eq(imports.id, importId), eq(imports.workspaceId, workspaceId)))
    .limit(1);
  return row ? toRecord(row) : null;
}

export async function requireImport(workspaceId: string, importId: string): Promise<ImportRecord> {
  const found = await getImport(workspaceId, importId);
  if (!found) throw new PageServiceError('not_found', 'Import not found');
  return found;
}

export async function listImportItems(importId: string): Promise<ImportItemRecord[]> {
  const db = getDatabase();
  const rows = await db
    .select(itemColumns)
    .from(importItems)
    .where(eq(importItems.importId, importId))
    .orderBy(asc(importItems.ordering), asc(importItems.sourceId));
  return rows.map(toItem);
}

export interface ListImportsOptions {
  spaceId?: string;
  limit?: number;
}

export async function listImports(
  workspaceId: string,
  options: ListImportsOptions = {},
): Promise<ImportRecord[]> {
  const db = getDatabase();
  const filters = [eq(imports.workspaceId, workspaceId)];
  if (options.spaceId) filters.push(eq(imports.spaceId, options.spaceId));

  const rows = await db
    .select(importColumns)
    .from(imports)
    .where(and(...filters))
    .orderBy(sql`${imports.createdAt} desc`)
    .limit(Math.min(Math.max(options.limit ?? 20, 1), 100));
  return rows.map(toRecord);
}

/* ------------------------------------------------------------------ */
/* Creating an import                                                  */
/* ------------------------------------------------------------------ */

export interface CreateImportInput {
  workspaceId: string;
  spaceId: string;
  spaceKey: string;
  actor: ImportActor;
  source: ImportSourceValue;
  /**
   * Reads the source. Called with the limits so an adapter can refuse an
   * oversized input while it parses rather than after. It is a callback rather
   * than a parsed result so that a failure is recorded on the import row the
   * caller can then look at.
   */
  parse: (limits: ImportLimits) => Promise<ImportParseResult> | ImportParseResult;
}

export async function createImport(input: CreateImportInput): Promise<ImportRecord> {
  const db = getDatabase();
  const [space] = await db
    .select({ id: spaces.id, key: spaces.key, archivedAt: spaces.archivedAt })
    .from(spaces)
    .where(and(eq(spaces.id, input.spaceId), eq(spaces.workspaceId, input.workspaceId)))
    .limit(1);
  if (!space) throw new PageServiceError('not_found', 'Space not found');
  if (space.archivedAt !== null) {
    throw new PageServiceError('conflict', 'This space is archived and takes no new pages', {
      space: space.key,
    });
  }

  const open = await db
    .select({ id: imports.id })
    .from(imports)
    .where(
      and(
        eq(imports.spaceId, input.spaceId),
        inArray(imports.status, ['pending', 'running', 'needs_review']),
      ),
    );
  if (open.length >= MAX_OPEN_IMPORTS_PER_SPACE) {
    throw new PageServiceError(
      'conflict',
      `This space already has ${open.length} imports waiting for review; finish or delete one first`,
      { open: open.length },
    );
  }

  const [created] = await db
    .insert(imports)
    .values({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
      source: input.source,
      status: 'running',
      createdBy: input.actor.id,
    })
    .returning(importColumns);
  if (!created) throw new PageServiceError('conflict', 'Import could not be created');

  try {
    const limits = importLimits();
    const parsed = await input.parse(limits);

    if (parsed.nodes.length > limits.pages) {
      throw new PageServiceError('validation', `An import may stage at most ${limits.pages} pages`, {
        limit: limits.pages,
      });
    }

    // Placement deliberately does *not* avoid the paths the space already has.
    // A page that collides is shown as a collision, with its natural path, and
    // the reviewer decides: leave it out, replace what is there, or move it.
    // Silently numbering it `-2` would hide the decision and produce a second
    // copy of a page nobody asked for.
    const existing = await livePathsOf(input.workspaceId, input.spaceId);
    const placed = placeNodes(parsed.nodes);

    if (placed.nodes.length > 0) {
      await db.insert(importItems).values(
        placed.nodes.map((node, index) => ({
          importId: created.id,
          sourceId: node.sourceId,
          title: node.title,
          targetPath: node.targetPath,
          parentSourceId: node.parentSourceId,
          markdown: node.markdown,
          warnings: node.warnings as unknown as Array<Record<string, unknown>>,
          decision: (existing.has(node.targetPath) ? 'skip' : 'create') as ImportDecisionValue,
          ordering: index,
        })),
      );
    }

    const stats = {
      parsed: placed.nodes.length,
      warnings: placed.nodes.reduce((total, node) => total + node.warnings.length, 0),
      conflicts: placed.nodes.filter((node) => existing.has(node.targetPath)).length,
      source_warnings: parsed.warnings.length,
    };

    const [updated] = await db
      .update(imports)
      .set({
        status: 'needs_review',
        params: parsed.params as Record<string, unknown>,
        stats,
        updatedAt: new Date(),
      })
      .where(eq(imports.id, created.id))
      .returning(importColumns);

    await recordAudit({
      workspaceId: input.workspaceId,
      actorType: 'user',
      actorId: input.actor.id,
      action: 'import.created',
      target: created.id,
      metadata: { space: space.key, source: input.source, ...stats },
    });

    return toRecord(updated ?? created);
  } catch (error) {
    const message = describeFailure(error);
    await db
      .update(imports)
      .set({ status: 'failed', error: message, updatedAt: new Date() })
      .where(eq(imports.id, created.id));
    await recordAudit({
      workspaceId: input.workspaceId,
      actorType: 'user',
      actorId: input.actor.id,
      action: 'import.failed',
      target: created.id,
      metadata: { space: space.key, source: input.source, reason: message },
    });
    throw toServiceError(error);
  }
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

export interface PreviewItem extends ImportItemRecord {
  /** The body with intra-import links resolved to the paths they will land on. */
  preview: string;
  /** A live page already at this path, when there is one. */
  conflictPageId: string | null;
  /** Who holds a claim on that page, when somebody does. */
  claimedBy: string | null;
}

export interface ImportPreview {
  import: ImportRecord;
  items: PreviewItem[];
  counts: { create: number; skip: number; overwrite: number; conflicts: number; claimed: number };
}

export async function previewImport(workspaceId: string, importId: string): Promise<ImportPreview> {
  const record = await requireImport(workspaceId, importId);
  const items = await listImportItems(record.id);
  const existing = await livePathsOf(workspaceId, record.spaceId);

  const pathsBySource = new Map(items.map((item) => [item.sourceId, item.targetPath]));
  const kept = new Set(items.filter((item) => item.decision !== 'skip').map((item) => item.sourceId));

  const conflictIds = items
    .map((item) => existing.get(item.targetPath))
    .filter((id): id is string => id !== undefined);
  const claimed = await claimHolders(workspaceId, conflictIds);

  const preview: PreviewItem[] = items.map((item) => {
    const conflictPageId = existing.get(item.targetPath) ?? null;
    return {
      ...item,
      preview: rewriteLinks(item.markdown, (sourceId) =>
        kept.has(sourceId) ? (pathsBySource.get(sourceId) ?? null) : null,
      ).markdown,
      conflictPageId,
      claimedBy: conflictPageId === null ? null : (claimed.get(conflictPageId) ?? null),
    };
  });

  return {
    import: record,
    items: preview,
    counts: {
      create: preview.filter((item) => item.decision === 'create').length,
      skip: preview.filter((item) => item.decision === 'skip').length,
      overwrite: preview.filter((item) => item.decision === 'overwrite').length,
      conflicts: preview.filter((item) => item.conflictPageId !== null).length,
      claimed: preview.filter((item) => item.claimedBy !== null).length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Editing one staged item                                             */
/* ------------------------------------------------------------------ */

export interface UpdateImportItemInput {
  workspaceId: string;
  importId: string;
  itemId: string;
  actor: ImportActor;
  decision?: ImportDecisionValue;
  targetPath?: string;
}

export async function updateImportItem(input: UpdateImportItemInput): Promise<ImportItemRecord> {
  const record = await requireImport(input.workspaceId, input.importId);
  if (record.status !== 'needs_review') {
    throw new PageServiceError('conflict', 'This import is no longer open for review', {
      status: record.status,
    });
  }

  const db = getDatabase();
  const [current] = await db
    .select(itemColumns)
    .from(importItems)
    .where(and(eq(importItems.id, input.itemId), eq(importItems.importId, record.id)))
    .limit(1);
  if (!current) throw new PageServiceError('not_found', 'Import item not found');

  const changes: { decision?: ImportDecisionValue; targetPath?: string } = {};
  if (input.decision !== undefined) changes.decision = input.decision;

  if (input.targetPath !== undefined) {
    let normalized: string;
    try {
      normalized = normalizePath(input.targetPath);
    } catch (error) {
      throw error instanceof InvalidPathError
        ? new PageServiceError('validation', error.message)
        : error;
    }
    // Two staged items at one path would race each other on apply, so the
    // collision is refused here where a person can still fix it.
    const [taken] = await db
      .select({ id: importItems.id })
      .from(importItems)
      .where(
        and(
          eq(importItems.importId, record.id),
          eq(importItems.targetPath, normalized),
          sql`${importItems.id} <> ${input.itemId}`,
        ),
      )
      .limit(1);
    if (taken) {
      throw new PageServiceError('conflict', 'Another item in this import already targets that path', {
        path: normalized,
      });
    }
    changes.targetPath = normalized;
  }

  if (Object.keys(changes).length === 0) return toItem(current);

  const [updated] = await db
    .update(importItems)
    .set(changes)
    .where(eq(importItems.id, input.itemId))
    .returning(itemColumns);
  if (!updated) throw new PageServiceError('not_found', 'Import item not found');

  await touch(record.id);
  return toItem(updated);
}

/* ------------------------------------------------------------------ */
/* Applying                                                            */
/* ------------------------------------------------------------------ */

export interface ApplyImportInput {
  workspaceId: string;
  importId: string;
  actor: ImportActor;
}

export interface AppliedItem {
  itemId: string;
  title: string;
  targetPath: string;
  pageId: string | null;
  /** Why nothing was written, when nothing was. */
  skipped?: 'decision' | 'conflict' | 'claimed' | 'failed';
  detail?: string;
}

export interface ApplyImportResult {
  import: ImportRecord;
  created: AppliedItem[];
  skipped: AppliedItem[];
}

/**
 * Writes the reviewed items into the space.
 *
 * Items are applied in placement order, so a parent exists before the page that
 * hangs off it. Links between imported pages are resolved to the addresses of
 * the pages this run creates: the ids are drawn first and handed to the page
 * service, which is why `createPage` takes an optional id — a batch that links
 * its own pages has to know where they will be before it writes any of them.
 *
 * Each item is its own transaction, inside `createPage`. One page that cannot
 * be written does not roll back the pages that already were: the result says
 * exactly what landed and what did not, which is more useful after a partial
 * failure than an all-or-nothing import that leaves a reviewer with nothing.
 */
export async function applyImport(input: ApplyImportInput): Promise<ApplyImportResult> {
  const record = await requireImport(input.workspaceId, input.importId);
  if (record.status !== 'needs_review') {
    throw new PageServiceError('conflict', 'This import is not waiting for review', {
      status: record.status,
    });
  }

  const db = getDatabase();
  const [space] = await db
    .select({ id: spaces.id, key: spaces.key, archivedAt: spaces.archivedAt })
    .from(spaces)
    .where(eq(spaces.id, record.spaceId))
    .limit(1);
  if (!space) throw new PageServiceError('not_found', 'Space not found');
  if (space.archivedAt !== null) {
    throw new PageServiceError('conflict', 'This space is archived and takes no new pages', {
      space: space.key,
    });
  }

  await db
    .update(imports)
    .set({ status: 'running', error: null, updatedAt: new Date() })
    .where(eq(imports.id, record.id));

  const items = await listImportItems(record.id);
  const existing = await livePathsOf(input.workspaceId, record.spaceId);

  // Every page this run will write, and the address it will have. Drawn before
  // anything is written so a link between two imported pages is already correct
  // in the body that gets stored.
  const plan = new Map<string, { itemId: string; pageId: string; targetPath: string }>();
  for (const item of items) {
    if (item.decision === 'skip') continue;
    const conflict = existing.get(item.targetPath);
    if (item.decision === 'create' && conflict !== undefined) continue;
    plan.set(item.sourceId, {
      itemId: item.id,
      pageId: item.decision === 'overwrite' && conflict !== undefined ? conflict : randomUUID(),
      targetPath: item.targetPath,
    });
  }

  const hrefOf = (sourceId: string): string | null => {
    const entry = plan.get(sourceId);
    return entry === undefined ? null : spacePageHref(space.key, entry.pageId);
  };

  const created: AppliedItem[] = [];
  const skipped: AppliedItem[] = [];
  const pathToPageId = new Map(existing);

  for (const item of items) {
    const base: AppliedItem = { itemId: item.id, title: item.title, targetPath: item.targetPath, pageId: null };

    if (item.decision === 'skip') {
      skipped.push({ ...base, skipped: 'decision' });
      continue;
    }
    const conflict = pathToPageId.get(item.targetPath);
    if (item.decision === 'create' && conflict !== undefined) {
      skipped.push({ ...base, skipped: 'conflict', detail: item.targetPath });
      continue;
    }

    const body = rewriteLinks(item.markdown, hrefOf).markdown;
    const parentId = item.parentSourceId === null ? null : (plan.get(item.parentSourceId)?.pageId ?? null);
    const entry = plan.get(item.sourceId);
    if (entry === undefined) {
      skipped.push({ ...base, skipped: 'conflict', detail: item.targetPath });
      continue;
    }

    try {
      const pageId =
        item.decision === 'overwrite' && conflict !== undefined
          ? await overwritePage({
              workspaceId: input.workspaceId,
              pageId: conflict,
              actor: input.actor,
              title: item.title,
              body,
            })
          : await createImportedPage({
              id: entry.pageId,
              workspaceId: input.workspaceId,
              spaceId: record.spaceId,
              actor: input.actor,
              title: item.title,
              body,
              path: item.targetPath,
              parentId,
            });

      await db.update(importItems).set({ createdPageId: pageId }).where(eq(importItems.id, item.id));
      pathToPageId.set(item.targetPath, pageId);

      await recordAudit({
        workspaceId: input.workspaceId,
        actorType: 'user',
        actorId: input.actor.id,
        action: 'page.imported',
        target: pageId,
        metadata: {
          space: space.key,
          import_id: record.id,
          source: record.source,
          path: item.targetPath,
          decision: item.decision,
        },
      });

      created.push({ ...base, pageId });
    } catch (error) {
      const claimReason = claimRefusal(error);
      skipped.push({
        ...base,
        skipped: claimReason === null ? 'failed' : 'claimed',
        detail: claimReason ?? describeFailure(error),
      });
    }
  }

  const stats = {
    ...record.stats,
    created: created.length,
    skipped: skipped.length,
    applied_at: new Date().toISOString(),
  };
  const [updated] = await db
    .update(imports)
    .set({ status: 'applied', stats, updatedAt: new Date() })
    .where(eq(imports.id, record.id))
    .returning(importColumns);

  await recordAudit({
    workspaceId: input.workspaceId,
    actorType: 'user',
    actorId: input.actor.id,
    action: 'import.applied',
    target: record.id,
    metadata: { space: space.key, source: record.source, created: created.length, skipped: skipped.length },
  });

  return { import: toRecord(updated ?? record), created, skipped };
}

interface CreateImportedPageInput {
  id: string;
  workspaceId: string;
  spaceId: string;
  actor: ImportActor;
  title: string;
  body: string;
  path: string;
  parentId: string | null;
}

async function createImportedPage(input: CreateImportedPageInput): Promise<string> {
  const page = await createPage({
    id: input.id,
    workspaceId: input.workspaceId,
    spaceId: input.spaceId,
    actor: { type: 'user', id: input.actor.id },
    title: input.title,
    body: input.body,
    // Imported documentation was written by people for people.
    kind: 'human',
    path: input.path,
    parentId: input.parentId,
  });
  return page.id;
}

/**
 * Replaces the body of a page that is already there.
 *
 * It goes through the ordinary claim protocol rather than around it: the import
 * takes a lease, writes under it, and gives it back. A page somebody else is
 * holding refuses the lease, and the item is reported as skipped — an import
 * does not get to take an edit away from the person making it.
 */
async function overwritePage(input: {
  workspaceId: string;
  pageId: string;
  actor: ImportActor;
  title: string;
  body: string;
}): Promise<string> {
  let claim;
  try {
    claim = await acquireClaim({
      workspaceId: input.workspaceId,
      pageId: input.pageId,
      actor: { type: 'user', id: input.actor.id, label: 'import' },
      sectionId: null,
    });
  } catch (error) {
    // A refused lease is not an error to report as a failure; it is the answer
    // that somebody is working on this page, and the item is skipped for it.
    if (isPageServiceError(error) && error.code === 'conflict') {
      const held = error.details?.['held_by'];
      throw new PageServiceError('conflict', 'The page is held by someone else', {
        reason: 'claimed',
        holder: typeof held === 'string' ? held : 'another editor',
      });
    }
    throw error;
  }

  try {
    await updatePage({
      workspaceId: input.workspaceId,
      pageId: input.pageId,
      actor: { type: 'user', id: input.actor.id },
      title: input.title,
      body: input.body,
      claimId: claim.claim.id,
      baseContentHash: claim.claim.baseContentHash,
    });
    return input.pageId;
  } finally {
    await releaseClaim({
      workspaceId: input.workspaceId,
      claimId: claim.claim.id,
      actor: { type: 'user', id: input.actor.id, label: 'import' },
    }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ */
/* Cancelling and deleting                                             */
/* ------------------------------------------------------------------ */

export async function cancelImport(
  workspaceId: string,
  importId: string,
  actor: ImportActor,
): Promise<ImportRecord> {
  const record = await requireImport(workspaceId, importId);
  if (record.status === 'applied') {
    throw new PageServiceError('conflict', 'This import has already been applied', {
      status: record.status,
    });
  }

  const db = getDatabase();
  const [updated] = await db
    .update(imports)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(imports.id, record.id))
    .returning(importColumns);

  await recordAudit({
    workspaceId,
    actorType: 'user',
    actorId: actor.id,
    action: 'import.cancelled',
    target: record.id,
    metadata: { source: record.source, from: record.status },
  });
  return toRecord(updated ?? record);
}

/**
 * Removes an import and its staged items. The pages it created are ordinary
 * pages and are untouched: deleting the record of how they arrived is not the
 * same as deleting them.
 */
export async function deleteImport(
  workspaceId: string,
  importId: string,
  actor: ImportActor,
): Promise<void> {
  const record = await requireImport(workspaceId, importId);
  const db = getDatabase();
  await db.delete(imports).where(eq(imports.id, record.id));
  await recordAudit({
    workspaceId,
    actorType: 'user',
    actorId: actor.id,
    action: 'import.deleted',
    target: record.id,
    metadata: { source: record.source, status: record.status },
  });
}

/**
 * Drops finished imports older than a cut-off. Staged Markdown is a copy of
 * somebody else's documents, and there is no reason to keep it once the import
 * is over.
 */
export async function purgeFinishedImports(workspaceId: string, before: Date): Promise<number> {
  const db = getDatabase();
  const removed = await db
    .delete(imports)
    .where(
      and(
        eq(imports.workspaceId, workspaceId),
        lt(imports.updatedAt, before),
        inArray(imports.status, ['applied', 'failed', 'cancelled']),
      ),
    )
    .returning({ id: imports.id });
  return removed.length;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Live pages of a space, by path, so a conflict is a map lookup. */
async function livePathsOf(workspaceId: string, spaceId: string): Promise<Map<string, string>> {
  const db = getDatabase();
  const rows = await db
    .select({ id: pages.id, path: pages.path })
    .from(pages)
    .where(
      and(eq(pages.workspaceId, workspaceId), eq(pages.spaceId, spaceId), isNull(pages.deletedAt)),
    );
  return new Map(rows.map((row) => [row.path, row.id]));
}

/** Who holds an active claim on each of these pages, when anybody does. */
async function claimHolders(
  workspaceId: string,
  pageIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const pageId of new Set(pageIds)) {
    const active = await getActiveClaimsForPage(workspaceId, pageId);
    const first = active[0];
    if (first) out.set(pageId, first.holderLabel);
  }
  return out;
}

async function touch(importId: string): Promise<void> {
  await getDatabase().update(imports).set({ updatedAt: new Date() }).where(eq(imports.id, importId));
}

/** The holder named by a refusal caused by somebody else's claim, or null. */
function claimRefusal(error: unknown): string | null {
  if (!isPageServiceError(error)) return null;
  const details = error.details ?? {};
  if (details['reason'] !== 'claimed') return null;
  return typeof details['holder'] === 'string' ? details['holder'] : 'another editor';
}

/** A message safe to store on the import row and show to the person who ran it. */
function describeFailure(error: unknown): string {
  if (isImportError(error) || isPageServiceError(error)) return error.message;
  console.error('[imports] unexpected failure', error);
  return 'The import could not be completed';
}

function toServiceError(error: unknown): unknown {
  if (isImportError(error)) {
    return new PageServiceError(
      error.code === 'unavailable' ? 'repository_unavailable' : 'validation',
      error.message,
      error.details,
    );
  }
  return error;
}

function toRecord(row: {
  id: string;
  workspaceId: string;
  spaceId: string;
  source: ImportSourceValue;
  status: ImportStatusValue;
  createdBy: string | null;
  params: Record<string, unknown>;
  stats: Record<string, unknown>;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ImportRecord {
  return { ...row };
}

function toItem(row: {
  id: string;
  importId: string;
  sourceId: string;
  title: string;
  targetPath: string;
  parentSourceId: string | null;
  markdown: string;
  warnings: Array<Record<string, unknown>>;
  decision: ImportDecisionValue;
  createdPageId: string | null;
  ordering: number;
}): ImportItemRecord {
  return { ...row, warnings: row.warnings as unknown as ImportWarning[] };
}
