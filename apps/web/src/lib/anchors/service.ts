import 'server-only';

import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { anchors, pages } from '@clewwiki/db';
import type { ActorKind, AnchorStateValue, WorkspaceSettings } from '@clewwiki/db';
import {
  buildFileIndex,
  extractDeclarations,
  languageForPath,
  lineRangeAnchor,
  resolveAnchor,
  SOURCE_EXTENSIONS,
} from '@clewwiki/anchors';
import type {
  AnchorDetail,
  AnchorTarget,
  Declaration,
  FileIndex,
  IndexedFile,
} from '@clewwiki/anchors';

import { recordAudit } from '../audit';
import { getDatabase } from '../db';
import { PageServiceError } from '../pages/errors';
import {
  listTree,
  MAX_SOURCE_BYTES,
  readBlob,
  requireRepositorySettings,
  resolveCommit,
  syncRepository,
  withRepositoryLock,
} from '../repository';
import { isSafeRepoPath } from '../repository/settings';

/**
 * The anchor service.
 *
 * An anchor is created against a declaration that exists *now*: the server
 * resolves it at creation time and stores the hashes it found, so the first
 * check has something to compare against and a typo in a symbol name is
 * refused at the point it is made rather than reported as `lost` a week later.
 *
 * A check recomputes state and writes it back. It never edits a page and never
 * re-points an anchor on its own — `docs/architecture.md` is explicit that a
 * human or an agent reviews and clears the flag, because a mechanism that
 * quietly fixes itself is a mechanism nobody can trust the silence of.
 *
 * Every function takes the caller's `workspaceId` and puts it in the SQL
 * predicate, so an anchor belonging to another workspace is invisible rather
 * than merely forbidden.
 */

export interface AnchorActor {
  type: ActorKind;
  id: string;
}

export interface AnchorRecord {
  id: string;
  workspaceId: string;
  pageId: string;
  sectionId: string | null;
  language: string;
  kind: string;
  qualifiedName: string;
  container: string | null;
  fileHint: string;
  tokenHash: string;
  bodyHash: string | null;
  bodyTokenCount: number;
  lineStart: number | null;
  lineEnd: number | null;
  fallback: boolean;
  state: AnchorStateValue;
  detail: Record<string, unknown> | null;
  lastCheckedRef: string | null;
  lastCheckedAt: Date | null;
  createdByType: ActorKind;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

const anchorColumns = {
  id: anchors.id,
  workspaceId: anchors.workspaceId,
  pageId: anchors.pageId,
  sectionId: anchors.sectionId,
  language: anchors.language,
  kind: anchors.kind,
  qualifiedName: anchors.qualifiedName,
  container: anchors.container,
  fileHint: anchors.fileHint,
  tokenHash: anchors.tokenHash,
  bodyHash: anchors.bodyHash,
  bodyTokenCount: anchors.bodyTokenCount,
  lineStart: anchors.lineStart,
  lineEnd: anchors.lineEnd,
  fallback: anchors.fallback,
  state: anchors.state,
  detail: anchors.detail,
  lastCheckedRef: anchors.lastCheckedRef,
  lastCheckedAt: anchors.lastCheckedAt,
  createdByType: anchors.createdByType,
  createdById: anchors.createdById,
  createdAt: anchors.createdAt,
  updatedAt: anchors.updatedAt,
} as const;

/**
 * Ceiling on how much of a repository one check will read.
 *
 * The move and rename stages of the ladder need a repository-wide view, and a
 * monorepo is large enough that "read everything" is not a plan. Files are
 * taken in path order up to this count; beyond it, the repository-wide stages
 * see a prefix of the tree rather than all of it, which loses recall on a move
 * and never invents one.
 */
const MAX_INDEXED_FILES = 4_000;

/** Section identifiers are the same shape claims already accept. */
const SECTION_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._/#-]{0,199}$/u;

/**
 * Readers for the stored `detail` blob.
 *
 * It is a JSON column, so it comes back as unknown values whatever was written
 * into it; a row written by an older release must not be able to turn a
 * confirm into a crash.
 */
function detailString(detail: Record<string, unknown> | null, key: string): string | null {
  const value = detail?.[key];
  return typeof value === 'string' ? value : null;
}

function detailNumber(detail: Record<string, unknown> | null, key: string): number | null {
  const value = detail?.[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

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

export async function listAnchorsForPage(
  workspaceId: string,
  pageId: string,
): Promise<AnchorRecord[]> {
  const db = getDatabase();
  return db
    .select(anchorColumns)
    .from(anchors)
    .where(and(eq(anchors.workspaceId, workspaceId), eq(anchors.pageId, pageId)))
    .orderBy(asc(anchors.fileHint), asc(anchors.qualifiedName));
}

export async function getAnchorById(
  workspaceId: string,
  anchorId: string,
): Promise<AnchorRecord | null> {
  const db = getDatabase();
  const [row] = await db
    .select(anchorColumns)
    .from(anchors)
    .where(and(eq(anchors.workspaceId, workspaceId), eq(anchors.id, anchorId)))
    .limit(1);
  return row ?? null;
}

/**
 * How many anchors on each page are not `fresh`.
 *
 * Read in bulk for the whole workspace, because the page tree needs a number
 * per node and one query per node is how a sidebar becomes slow.
 */
export async function getStaleAnchorCounts(workspaceId: string): Promise<Map<string, number>> {
  const db = getDatabase();
  const rows = await db
    .select({ pageId: anchors.pageId, count: sql<number>`count(*)::int` })
    .from(anchors)
    .where(and(eq(anchors.workspaceId, workspaceId), ne(anchors.state, 'fresh')))
    .groupBy(anchors.pageId);
  return new Map(rows.map((row) => [row.pageId, row.count]));
}

export interface FallbackShare {
  total: number;
  fallback: number;
  /** Between 0 and 1; zero when the workspace has no anchors at all. */
  share: number;
}

/**
 * The share of a workspace's anchors sitting on the line-range fallback.
 *
 * Reported rather than merely recorded: a line range does not survive an edit
 * above it, so a repository where this number climbs is a repository where the
 * staleness badge is on its way to being noise. It is the early warning the
 * mechanism's design calls for.
 */
export async function getFallbackShare(workspaceId: string): Promise<FallbackShare> {
  const db = getDatabase();
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      fallback: sql<number>`count(*) filter (where ${anchors.fallback})::int`,
    })
    .from(anchors)
    .where(eq(anchors.workspaceId, workspaceId));

  const total = row?.total ?? 0;
  const fallback = row?.fallback ?? 0;
  return { total, fallback, share: total === 0 ? 0 : fallback / total };
}

/* ------------------------------------------------------------------ */
/* Repository reads                                                    */
/* ------------------------------------------------------------------ */

interface RepositoryContext {
  dir: string;
  commit: string;
  ref: string;
  settings: ReturnType<typeof requireRepositorySettings>;
}

async function openRepository(
  workspaceId: string,
  workspaceSettings: WorkspaceSettings | null | undefined,
  requestedRef?: string | null,
): Promise<RepositoryContext> {
  const settings = requireRepositorySettings(workspaceSettings);
  const ref = requestedRef && requestedRef.trim() !== '' ? requestedRef.trim() : settings.default_ref;
  const dir = await syncRepository(workspaceId, settings);
  const commit = await resolveCommit(dir, ref, settings);
  return { dir, commit, ref, settings };
}

async function readSource(context: RepositoryContext, filePath: string): Promise<string | null> {
  const source = await readBlob(context.dir, context.commit, filePath, context.settings);
  if (source === null) return null;
  if (source.length > MAX_SOURCE_BYTES) return null;
  return source;
}

async function indexOneFile(
  context: RepositoryContext,
  filePath: string,
): Promise<IndexedFile | null> {
  const source = await readSource(context, filePath);
  if (source === null) return null;
  const language = languageForPath(filePath);
  const declarations: Declaration[] =
    language === null ? [] : await extractDeclarations(language, source);
  return { path: filePath, source, declarations };
}

/**
 * Parses every source file in the revision, up to `MAX_INDEXED_FILES`.
 *
 * Only built when the cheap pass could not answer — the ladder's first rung
 * needs one file, and the overwhelming majority of anchors never leave it.
 */
async function buildRepositoryIndex(
  context: RepositoryContext,
  extraPaths: readonly string[],
): Promise<FileIndex> {
  const tree = await listTree(context.dir, context.commit, context.settings);
  const wanted = tree
    .filter((entry) => SOURCE_EXTENSIONS.some((extension) => entry.toLowerCase().endsWith(extension)))
    .filter((entry) => isSafeRepoPath(entry))
    .slice(0, MAX_INDEXED_FILES);

  const paths = new Set<string>(wanted);
  for (const extra of extraPaths) paths.add(extra);

  const files: IndexedFile[] = [];
  for (const filePath of paths) {
    const indexed = await indexOneFile(context, filePath);
    if (indexed !== null) files.push(indexed);
  }
  return buildFileIndex(files);
}

/* ------------------------------------------------------------------ */
/* Creation                                                            */
/* ------------------------------------------------------------------ */

export interface CreateAnchorInput {
  workspaceId: string;
  pageId: string;
  actor: AnchorActor;
  workspaceSettings: WorkspaceSettings | null | undefined;
  file: string;
  qualifiedName?: string | null;
  kind?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  sectionId?: string | null;
  ref?: string | null;
}

function pickDeclaration(
  declarations: readonly Declaration[],
  qualifiedName: string,
  kind: string | null | undefined,
): Declaration {
  const named = declarations.filter((entry) => entry.qualifiedName === qualifiedName);
  const matching = kind ? named.filter((entry) => entry.kind === kind) : named;

  if (matching.length === 0) {
    throw new PageServiceError(
      'validation',
      `No declaration named ${qualifiedName} in that file`,
      {
        available: declarations.slice(0, 50).map((entry) => ({
          kind: entry.kind,
          qualified_name: entry.qualifiedName,
        })),
      },
    );
  }
  if (matching.length > 1) {
    throw new PageServiceError(
      'validation',
      `${qualifiedName} is declared more than once in that file; name its kind`,
      { kinds: matching.map((entry) => entry.kind) },
    );
  }
  // `matching` has exactly one element here; the index access is checked so
  // that `noUncheckedIndexedAccess` stays on for the whole file.
  const only = matching[0];
  if (!only) throw new PageServiceError('validation', `No declaration named ${qualifiedName}`);
  return only;
}

/**
 * Creates an anchor, resolving it against the repository first.
 *
 * Two shapes are accepted, and the first is strongly preferred: a declaration
 * (`file` plus `qualified_name`), or a line range (`file` plus
 * `line_start`/`line_end`) for a block that has no declaration to point at.
 */
export async function createAnchor(input: CreateAnchorInput): Promise<AnchorRecord> {
  const db = getDatabase();

  if (!isSafeRepoPath(input.file)) {
    throw new PageServiceError('validation', 'Unsupported repository path');
  }
  const sectionId = input.sectionId?.trim() ? input.sectionId.trim() : null;
  if (sectionId !== null && !SECTION_ID_PATTERN.test(sectionId)) {
    throw new PageServiceError('validation', 'Section identifier is not valid');
  }

  const [page] = await db
    .select({ id: pages.id })
    .from(pages)
    .where(
      and(
        eq(pages.workspaceId, input.workspaceId),
        eq(pages.id, input.pageId),
        sql`${pages.deletedAt} is null`,
      ),
    )
    .limit(1);
  if (!page) throw new PageServiceError('not_found', 'Page not found');

  const values = await withRepositoryLock(input.workspaceId, async () => {
    const context = await openRepository(input.workspaceId, input.workspaceSettings, input.ref);
    const source = await readSource(context, input.file);
    if (source === null) {
      throw new PageServiceError('validation', `File not found at ${context.ref}: ${input.file}`);
    }

    const language = languageForPath(input.file);

    if (input.qualifiedName && input.qualifiedName.trim() !== '') {
      if (language === null) {
        throw new PageServiceError(
          'validation',
          'No grammar for that file; anchor it by line range instead',
        );
      }
      const declarations = await extractDeclarations(language, source);
      const declaration = pickDeclaration(declarations, input.qualifiedName.trim(), input.kind);
      return {
        language,
        kind: declaration.kind,
        qualifiedName: declaration.qualifiedName,
        container: declaration.container,
        tokenHash: declaration.tokenHash,
        bodyHash: declaration.bodyHash,
        bodyTokenCount: declaration.bodyTokenCount,
        lineStart: declaration.startLine,
        lineEnd: declaration.endLine,
        fallback: false,
        ref: context.ref,
      };
    }

    if (
      typeof input.lineStart === 'number' &&
      typeof input.lineEnd === 'number' &&
      input.lineStart > 0
    ) {
      const range = lineRangeAnchor(source, input.lineStart, input.lineEnd);
      if (range === null) {
        throw new PageServiceError(
          'validation',
          `Lines ${input.lineStart}–${input.lineEnd} are not in that file`,
        );
      }
      return {
        language: language ?? 'none',
        kind: 'lines',
        qualifiedName: `${input.file}:${range.lineStart}-${range.lineEnd}`,
        container: null,
        tokenHash: range.hash,
        bodyHash: null,
        bodyTokenCount: 0,
        lineStart: range.lineStart,
        lineEnd: range.lineEnd,
        fallback: true,
        ref: context.ref,
      };
    }

    throw new PageServiceError(
      'validation',
      'An anchor needs either a qualified name or a line range',
    );
  });

  try {
    const [row] = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(anchors)
        .values({
          workspaceId: input.workspaceId,
          pageId: input.pageId,
          sectionId,
          language: values.language,
          kind: values.kind,
          qualifiedName: values.qualifiedName,
          container: values.container,
          fileHint: input.file,
          tokenHash: values.tokenHash,
          bodyHash: values.bodyHash,
          bodyTokenCount: values.bodyTokenCount,
          lineStart: values.lineStart,
          lineEnd: values.lineEnd,
          fallback: values.fallback,
          state: 'fresh',
          detail: { reason: 'identity_matched', file: input.file } satisfies AnchorDetail,
          lastCheckedRef: values.ref,
          lastCheckedAt: new Date(),
          createdByType: input.actor.type,
          createdById: input.actor.id,
        })
        .returning(anchorColumns);

      const created = inserted[0];
      if (!created) throw new PageServiceError('conflict', 'The anchor could not be created');

      await recordAudit(
        {
          workspaceId: input.workspaceId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: 'anchor.created',
          target: created.id,
          metadata: {
            page_id: input.pageId,
            section_id: sectionId,
            file: input.file,
            qualified_name: values.qualifiedName,
            kind: values.kind,
            fallback: values.fallback,
            ref: values.ref,
          },
        },
        tx,
      );

      return inserted;
    });

    if (!row) throw new PageServiceError('conflict', 'The anchor could not be created');
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PageServiceError('conflict', 'That target is already anchored on this section');
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Deletion                                                            */
/* ------------------------------------------------------------------ */

export interface DeleteAnchorInput {
  workspaceId: string;
  anchorId: string;
  actor: AnchorActor;
}

export async function deleteAnchor(input: DeleteAnchorInput): Promise<AnchorRecord> {
  const db = getDatabase();

  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(anchors)
      .where(and(eq(anchors.workspaceId, input.workspaceId), eq(anchors.id, input.anchorId)))
      .returning(anchorColumns);

    const row = deleted[0];
    if (!row) throw new PageServiceError('not_found', 'Anchor not found');

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'anchor.deleted',
        target: row.id,
        metadata: {
          page_id: row.pageId,
          file: row.fileHint,
          qualified_name: row.qualifiedName,
        },
      },
      tx,
    );

    return row;
  });
}

/* ------------------------------------------------------------------ */
/* Checking                                                            */
/* ------------------------------------------------------------------ */

function toTarget(record: AnchorRecord): AnchorTarget {
  return {
    language: languageForPath(record.fileHint),
    kind: record.kind,
    qualifiedName: record.qualifiedName,
    container: record.container,
    fileHint: record.fileHint,
    tokenHash: record.tokenHash,
    bodyHash: record.bodyHash,
    bodyTokenCount: record.bodyTokenCount,
    fallback: record.fallback,
    lineStart: record.lineStart,
    lineEnd: record.lineEnd,
  };
}

export interface CheckAnchorsInput {
  workspaceId: string;
  pageId: string;
  actor: AnchorActor;
  workspaceSettings: WorkspaceSettings | null | undefined;
  ref?: string | null;
}

export interface CheckAnchorsResult {
  checkedAt: Date;
  ref: string;
  commit: string;
  anchors: AnchorRecord[];
  fallbackShare: FallbackShare;
}

/**
 * Recomputes every anchor on one page and writes the result back.
 *
 * The repository is read twice at most: once for the files the anchors already
 * point at, and — only if something failed to resolve there — once more for
 * the whole tree, which is what the move and rename stages need. A page whose
 * anchors are all still where they were never pays for the second pass.
 */
export async function checkPageAnchors(input: CheckAnchorsInput): Promise<CheckAnchorsResult> {
  const db = getDatabase();
  const existing = await listAnchorsForPage(input.workspaceId, input.pageId);

  if (existing.length === 0) {
    const settings = requireRepositorySettings(input.workspaceSettings);
    return {
      checkedAt: new Date(),
      ref: input.ref?.trim() || settings.default_ref,
      commit: '',
      anchors: [],
      fallbackShare: await getFallbackShare(input.workspaceId),
    };
  }

  const { context, resolutions } = await withRepositoryLock(input.workspaceId, async () => {
    const opened = await openRepository(input.workspaceId, input.workspaceSettings, input.ref);

    const hinted = [...new Set(existing.map((anchor) => anchor.fileHint))];
    const nearby: IndexedFile[] = [];
    for (const filePath of hinted) {
      const indexed = await indexOneFile(opened, filePath);
      if (indexed !== null) nearby.push(indexed);
    }

    let index = buildFileIndex(nearby);
    const results = new Map(existing.map((anchor) => [anchor.id, resolveAnchor(toTarget(anchor), index)]));

    // Anything the cheap pass could not find may have moved or been renamed;
    // only those need the repository-wide view.
    const unresolved = existing.filter((anchor) => results.get(anchor.id)?.state === 'lost');
    if (unresolved.length > 0) {
      index = await buildRepositoryIndex(opened, hinted);
      for (const anchor of unresolved) {
        results.set(anchor.id, resolveAnchor(toTarget(anchor), index));
      }
    }

    return { context: opened, resolutions: results };
  });

  const checkedAt = new Date();
  const updated: AnchorRecord[] = [];

  await db.transaction(async (tx) => {
    for (const anchor of existing) {
      const resolution = resolutions.get(anchor.id);
      if (!resolution) continue;

      const rows = await tx
        .update(anchors)
        .set({
          state: resolution.state,
          detail: { ...resolution.detail },
          lastCheckedRef: context.ref,
          lastCheckedAt: checkedAt,
          updatedAt: checkedAt,
        })
        .where(and(eq(anchors.workspaceId, input.workspaceId), eq(anchors.id, anchor.id)))
        .returning(anchorColumns);

      const row = rows[0];
      if (row) updated.push(row);
    }

    const counts = updated.reduce<Record<string, number>>((accumulator, anchor) => {
      accumulator[anchor.state] = (accumulator[anchor.state] ?? 0) + 1;
      return accumulator;
    }, {});

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'anchor.checked',
        target: input.pageId,
        metadata: { ref: context.ref, commit: context.commit, checked: updated.length, ...counts },
      },
      tx,
    );
  });

  return {
    checkedAt,
    ref: context.ref,
    commit: context.commit,
    anchors: updated,
    fallbackShare: await getFallbackShare(input.workspaceId),
  };
}

/* ------------------------------------------------------------------ */
/* Confirmation                                                        */
/* ------------------------------------------------------------------ */

export interface ConfirmAnchorInput {
  workspaceId: string;
  anchorId: string;
  actor: AnchorActor;
  workspaceSettings: WorkspaceSettings | null | undefined;
  ref?: string | null;
}

/**
 * Clears a flag after a person or an agent has reviewed it.
 *
 * This is the only path that moves an anchor onto a new declaration, and it is
 * deliberately an explicit act: the reviewer has read the change and says the
 * documentation still describes the code. A `lost` anchor cannot be confirmed
 * — there is nothing to re-baseline against, and the honest answer is to fix
 * the page or delete the anchor.
 */
export async function confirmAnchor(input: ConfirmAnchorInput): Promise<AnchorRecord> {
  const db = getDatabase();
  const anchor = await getAnchorById(input.workspaceId, input.anchorId);
  if (!anchor) throw new PageServiceError('not_found', 'Anchor not found');

  const rebaselined = await withRepositoryLock(input.workspaceId, async () => {
    const context = await openRepository(input.workspaceId, input.workspaceSettings, input.ref);

    // Where to look now: the file the last check found it in, falling back to
    // the file the anchor still names.
    const detail = anchor.detail;
    const movedTo = detailString(detail, 'moved_to');
    const lastFile = detailString(detail, 'file');
    const file =
      movedTo !== null && isSafeRepoPath(movedTo)
        ? movedTo
        : lastFile !== null && isSafeRepoPath(lastFile)
          ? lastFile
          : anchor.fileHint;

    const source = await readSource(context, file);
    if (source === null) {
      throw new PageServiceError('validation', `File not found at ${context.ref}: ${file}`);
    }

    if (anchor.fallback) {
      const start = detailNumber(detail, 'line_start') ?? anchor.lineStart;
      const end = detailNumber(detail, 'line_end') ?? anchor.lineEnd;
      if (typeof start !== 'number' || typeof end !== 'number') {
        throw new PageServiceError('validation', 'This anchor has no line range to re-baseline');
      }
      const range = lineRangeAnchor(source, start, end);
      if (range === null) {
        throw new PageServiceError('validation', 'Those lines are no longer in the file');
      }
      return {
        fileHint: file,
        kind: anchor.kind,
        qualifiedName: `${file}:${range.lineStart}-${range.lineEnd}`,
        container: anchor.container,
        language: anchor.language,
        tokenHash: range.hash,
        bodyHash: null,
        bodyTokenCount: 0,
        lineStart: range.lineStart,
        lineEnd: range.lineEnd,
        ref: context.ref,
      };
    }

    const language = languageForPath(file);
    if (language === null) {
      throw new PageServiceError('validation', 'No grammar for that file');
    }

    const declarations = await extractDeclarations(language, source);
    const name = detailString(detail, 'renamed_to') ?? anchor.qualifiedName;
    const found =
      declarations.find((entry) => entry.qualifiedName === name && entry.kind === anchor.kind) ??
      declarations.find((entry) => entry.qualifiedName === name);

    if (!found) {
      throw new PageServiceError(
        'validation',
        'That declaration is gone; fix the page or delete the anchor',
      );
    }

    return {
      fileHint: file,
      kind: found.kind,
      qualifiedName: found.qualifiedName,
      container: found.container,
      language,
      tokenHash: found.tokenHash,
      bodyHash: found.bodyHash,
      bodyTokenCount: found.bodyTokenCount,
      lineStart: found.startLine,
      lineEnd: found.endLine,
      ref: context.ref,
    };
  });

  const now = new Date();

  return db.transaction(async (tx) => {
    const rows = await tx
      .update(anchors)
      .set({
        fileHint: rebaselined.fileHint,
        kind: rebaselined.kind,
        qualifiedName: rebaselined.qualifiedName,
        container: rebaselined.container,
        language: rebaselined.language,
        tokenHash: rebaselined.tokenHash,
        bodyHash: rebaselined.bodyHash,
        bodyTokenCount: rebaselined.bodyTokenCount,
        lineStart: rebaselined.lineStart,
        lineEnd: rebaselined.lineEnd,
        state: 'fresh',
        detail: {
          reason: 'identity_matched',
          file: rebaselined.fileHint,
          line_start: rebaselined.lineStart ?? undefined,
          line_end: rebaselined.lineEnd ?? undefined,
        } satisfies AnchorDetail,
        lastCheckedRef: rebaselined.ref,
        lastCheckedAt: now,
        updatedAt: now,
      })
      .where(and(eq(anchors.workspaceId, input.workspaceId), eq(anchors.id, input.anchorId)))
      .returning(anchorColumns);

    const row = rows[0];
    if (!row) throw new PageServiceError('not_found', 'Anchor not found');

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'anchor.confirmed',
        target: row.id,
        metadata: {
          page_id: row.pageId,
          previous_state: anchor.state,
          previous_qualified_name: anchor.qualifiedName,
          previous_file: anchor.fileHint,
          file: row.fileHint,
          qualified_name: row.qualifiedName,
          ref: rebaselined.ref,
        },
      },
      tx,
    );

    return row;
  });
}
