import 'server-only';

import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { devReleases, devStreams, discussions, pages } from '@clewwiki/db';
import type { DevStreamBranch, Workspace } from '@clewwiki/db';

import { recordAudit } from '../audit';
import { getDatabase } from '../db';
import { PageServiceError } from '../pages/errors';
import { createPage, getPageById } from '../pages/service';
import type { PageActor } from '../pages/service';
import { isSafeRef, listBranches, readRepositorySettings, syncRepository, withRepositoryLock } from '../repository';
import { getSpaceById } from '../spaces/service';
import type { SpaceRecord } from '../spaces/service';
import { findIssueKeys, readTrackers } from '../trackers/settings';

/**
 * A space's development: its lines of work — usually one per git branch — and
 * the releases they are meant to ship in.
 *
 * The point of the overview is the question a team gets wrong when nobody
 * owns it: *what is in the main branch, and what still has to get there before
 * the release goes out?* Each stream carries the branch as the last sync saw
 * it — merged into the default branch or not, how far ahead and behind — and
 * a release lists its streams with exactly that. Branch state is read from
 * the space's repository only when somebody syncs, never on a page view.
 *
 * A stream's problems are the discussions attached to it; when one is
 * resolved, its decision page is written under the stream's documentation
 * page, so the record stays with the branch after the thread is deleted.
 */

export const STREAM_STATES = ['planned', 'active', 'review', 'merged', 'paused', 'dropped'] as const;
export type StreamState = (typeof STREAM_STATES)[number];
/** States a stream is still being worked in. */
export const OPEN_STATES: readonly StreamState[] = ['planned', 'active', 'review', 'paused'];

export interface StreamRecord {
  id: string;
  spaceId: string;
  title: string;
  ref: string | null;
  state: StreamState;
  goal: string;
  issueKeys: string[];
  releaseId: string | null;
  docsPageId: string | null;
  branch: DevStreamBranch | null;
  createdAt: Date;
  updatedAt: Date;
  mergedAt: Date | null;
}

export interface ReleaseRecord {
  id: string;
  spaceId: string;
  name: string;
  state: 'planned' | 'shipped';
  dueOn: string | null;
  notes: string;
  createdAt: Date;
  shippedAt: Date | null;
}

const streamColumns = {
  id: devStreams.id,
  spaceId: devStreams.spaceId,
  title: devStreams.title,
  ref: devStreams.ref,
  state: devStreams.state,
  goal: devStreams.goal,
  issueKeys: devStreams.issueKeys,
  releaseId: devStreams.releaseId,
  docsPageId: devStreams.docsPageId,
  branch: devStreams.branch,
  createdAt: devStreams.createdAt,
  updatedAt: devStreams.updatedAt,
  mergedAt: devStreams.mergedAt,
};

const releaseColumns = {
  id: devReleases.id,
  spaceId: devReleases.spaceId,
  name: devReleases.name,
  state: devReleases.state,
  dueOn: devReleases.dueOn,
  notes: devReleases.notes,
  createdAt: devReleases.createdAt,
  shippedAt: devReleases.shippedAt,
};

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/;
const RELEASE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._+-]{0,39}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function cleanTitle(raw: string): string {
  const title = raw.trim().replace(/\s+/g, ' ');
  if (title === '' || title.length > 120) throw new PageServiceError('validation', 'A stream title is 1 to 120 characters');
  return title;
}

function cleanRef(raw: string | null | undefined): string | null {
  const ref = (raw ?? '').trim();
  if (ref === '') return null;
  if (ref.length > 200 || !isSafeRef(ref)) throw new PageServiceError('validation', `Unsupported branch name: ${ref}`);
  return ref;
}

function cleanGoal(raw: string | undefined): string {
  const goal = (raw ?? '').trim();
  if (goal.length > 20_000) throw new PageServiceError('validation', 'A goal is at most 20000 characters');
  return goal;
}

function cleanKeys(raw: readonly string[] | undefined): string[] {
  const keys = [...new Set((raw ?? []).map((key) => key.trim().toUpperCase()).filter(Boolean))];
  if (keys.length > 50 || !keys.every((key) => ISSUE_KEY.test(key))) {
    throw new PageServiceError('validation', 'Issue keys look like MAC-42; at most 50');
  }
  return keys;
}

function cleanReleaseName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!RELEASE_NAME.test(name)) {
    throw new PageServiceError('validation', 'A release name is up to 40 letters, digits, spaces, dots, dashes or pluses');
  }
  return name;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function listStreams(workspaceId: string, spaceId: string): Promise<StreamRecord[]> {
  const rows = await getDatabase()
    .select(streamColumns)
    .from(devStreams)
    .where(and(eq(devStreams.workspaceId, workspaceId), eq(devStreams.spaceId, spaceId)))
    .orderBy(desc(devStreams.updatedAt));
  return rows as StreamRecord[];
}

export async function getStream(workspaceId: string, streamId: string): Promise<StreamRecord | null> {
  const [row] = await getDatabase()
    .select(streamColumns)
    .from(devStreams)
    .where(and(eq(devStreams.workspaceId, workspaceId), eq(devStreams.id, streamId)))
    .limit(1);
  return (row as StreamRecord | undefined) ?? null;
}

export async function listReleases(workspaceId: string, spaceId: string): Promise<ReleaseRecord[]> {
  const rows = await getDatabase()
    .select(releaseColumns)
    .from(devReleases)
    .where(and(eq(devReleases.workspaceId, workspaceId), eq(devReleases.spaceId, spaceId)))
    .orderBy(asc(devReleases.state), asc(devReleases.dueOn), asc(devReleases.createdAt));
  return rows as ReleaseRecord[];
}

/** Open problems — discussions — per stream. */
export async function countOpenProblems(workspaceId: string, streamIds: string[]): Promise<Map<string, number>> {
  if (streamIds.length === 0) return new Map();
  const rows = await getDatabase()
    .select({ streamId: discussions.streamId, total: count() })
    .from(discussions)
    .where(
      and(eq(discussions.workspaceId, workspaceId), inArray(discussions.streamId, streamIds), eq(discussions.status, 'open')),
    )
    .groupBy(discussions.streamId);
  return new Map(rows.map((row) => [row.streamId ?? '', Number(row.total)]));
}

/** Every issue key a stream carries: listed by hand, in its branch name, its title or its goal. */
export function streamIssueKeys(stream: StreamRecord, workspace: Pick<Workspace, 'settings'>): string[] {
  const trackers = readTrackers(workspace);
  const found = findIssueKeys([stream.ref ?? '', stream.title, stream.goal].join('\n'), trackers);
  return [...new Set([...stream.issueKeys, ...found])];
}

/** Whether a stream has reached the default branch: synced as merged, or marked so. */
export function isMerged(stream: StreamRecord): boolean {
  return stream.state === 'merged' || stream.branch?.merged === true;
}

export interface DevelopmentOverview {
  releases: Array<{ release: ReleaseRecord; streams: StreamRecord[]; missing: StreamRecord[] }>;
  /** In the default branch, with no release to say when it ships. */
  mergedUnreleased: StreamRecord[];
  /** Still in progress and not planned into any release. */
  unplanned: StreamRecord[];
  /** Merged or dropped, and already accounted for. */
  closed: StreamRecord[];
}

export function buildOverview(streams: StreamRecord[], releases: ReleaseRecord[]): DevelopmentOverview {
  const byRelease = new Map<string, StreamRecord[]>();
  for (const stream of streams) {
    if (stream.releaseId) byRelease.set(stream.releaseId, [...(byRelease.get(stream.releaseId) ?? []), stream]);
  }
  const live = (stream: StreamRecord) => stream.state !== 'dropped';
  return {
    releases: releases.map((release) => {
      const included = (byRelease.get(release.id) ?? []).filter(live);
      return { release, streams: included, missing: included.filter((stream) => !isMerged(stream)) };
    }),
    mergedUnreleased: streams.filter((stream) => live(stream) && isMerged(stream) && !stream.releaseId),
    unplanned: streams.filter((stream) => !stream.releaseId && (OPEN_STATES as readonly string[]).includes(stream.state) && !isMerged(stream)),
    closed: streams.filter((stream) => stream.state === 'dropped'),
  };
}

/* ------------------------------------------------------------------ */
/* Streams                                                             */
/* ------------------------------------------------------------------ */

async function requireSpace(workspaceId: string, spaceId: string): Promise<SpaceRecord> {
  const space = await getSpaceById(workspaceId, spaceId);
  if (!space) throw new PageServiceError('not_found', 'Space not found');
  if (space.archivedAt !== null) throw new PageServiceError('conflict', 'This space is archived');
  return space;
}

async function requireRelease(workspaceId: string, spaceId: string, releaseId: string | null | undefined): Promise<string | null> {
  if (!releaseId) return null;
  const [row] = await getDatabase()
    .select({ id: devReleases.id })
    .from(devReleases)
    .where(and(eq(devReleases.workspaceId, workspaceId), eq(devReleases.spaceId, spaceId), eq(devReleases.id, releaseId)))
    .limit(1);
  if (!row) throw new PageServiceError('not_found', 'Release not found in this space');
  return row.id;
}

async function requireDocsPage(workspaceId: string, spaceId: string, pageId: string | null | undefined): Promise<string | null> {
  if (!pageId) return null;
  const page = await getPageById(workspaceId, pageId);
  if (!page || page.spaceId !== spaceId || page.deletedAt !== null) throw new PageServiceError('not_found', 'Page not found');
  return page.id;
}

export interface StreamInput {
  title?: string;
  ref?: string | null;
  state?: StreamState;
  goal?: string;
  issueKeys?: string[];
  releaseId?: string | null;
  docsPageId?: string | null;
}

/** A unique-index violation, whether the driver's error or the ORM's wrapper around it. */
function uniqueRefConflict(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 3; depth += 1) {
    if (typeof current === 'object' && (current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function createStream(
  workspaceId: string,
  spaceId: string,
  actor: PageActor,
  input: StreamInput & { title: string },
): Promise<StreamRecord> {
  await requireSpace(workspaceId, spaceId);
  const values = {
    workspaceId,
    spaceId,
    title: cleanTitle(input.title),
    ref: cleanRef(input.ref),
    state: input.state ?? 'active',
    goal: cleanGoal(input.goal),
    issueKeys: cleanKeys(input.issueKeys),
    releaseId: await requireRelease(workspaceId, spaceId, input.releaseId),
    docsPageId: await requireDocsPage(workspaceId, spaceId, input.docsPageId),
    createdByType: actor.type,
    createdById: actor.id,
    mergedAt: input.state === 'merged' ? new Date() : null,
  };
  try {
    return await getDatabase().transaction(async (tx) => {
      const [row] = await tx.insert(devStreams).values(values).returning(streamColumns);
      if (!row) throw new PageServiceError('conflict', 'The stream could not be created');
      await recordAudit(
        { workspaceId, actorType: actor.type, actorId: actor.id, action: 'stream.created', target: row.id, metadata: { title: row.title, ref: row.ref } },
        tx,
      );
      return row as StreamRecord;
    });
  } catch (error) {
    if (uniqueRefConflict(error)) throw new PageServiceError('conflict', 'A stream for this branch already exists');
    throw error;
  }
}

export async function updateStream(
  workspaceId: string,
  streamId: string,
  actor: PageActor,
  input: StreamInput,
): Promise<StreamRecord> {
  const current = await getStream(workspaceId, streamId);
  if (!current) throw new PageServiceError('not_found', 'Stream not found');
  await requireSpace(workspaceId, current.spaceId);
  const patch: Partial<typeof devStreams.$inferInsert> = { updatedAt: new Date() };
  if (input.title !== undefined) patch.title = cleanTitle(input.title);
  if (input.ref !== undefined) patch.ref = cleanRef(input.ref);
  if (input.goal !== undefined) patch.goal = cleanGoal(input.goal);
  if (input.issueKeys !== undefined) patch.issueKeys = cleanKeys(input.issueKeys);
  if (input.releaseId !== undefined) patch.releaseId = await requireRelease(workspaceId, current.spaceId, input.releaseId);
  if (input.docsPageId !== undefined) patch.docsPageId = await requireDocsPage(workspaceId, current.spaceId, input.docsPageId);
  if (input.state !== undefined) {
    patch.state = input.state;
    if (input.state === 'merged' && current.mergedAt === null) patch.mergedAt = new Date();
  }
  try {
    return await getDatabase().transaction(async (tx) => {
      const [row] = await tx
        .update(devStreams)
        .set(patch)
        .where(and(eq(devStreams.workspaceId, workspaceId), eq(devStreams.id, streamId)))
        .returning(streamColumns);
      if (!row) throw new PageServiceError('not_found', 'Stream not found');
      await recordAudit(
        {
          workspaceId,
          actorType: actor.type,
          actorId: actor.id,
          action: 'stream.updated',
          target: row.id,
          metadata: { fields: Object.keys(input), state: row.state },
        },
        tx,
      );
      return row as StreamRecord;
    });
  } catch (error) {
    if (uniqueRefConflict(error)) throw new PageServiceError('conflict', 'A stream for this branch already exists');
    throw error;
  }
}

export const DEVELOPMENT_PAGE_SLUG = 'development';

/**
 * The stream's documentation page, created under the space's `/development`
 * page when it has none: where its notes go, and where its problems' decisions
 * are written.
 */
export async function ensureDocsPage(
  workspaceId: string,
  streamId: string,
  actor: PageActor,
  labels: { rootTitle: string; rootBody: string; pageTitle: (name: string) => string; pageBody: (goal: string) => string },
): Promise<string> {
  const stream = await getStream(workspaceId, streamId);
  if (!stream) throw new PageServiceError('not_found', 'Stream not found');
  if (stream.docsPageId) {
    const existing = await getPageById(workspaceId, stream.docsPageId);
    if (existing && existing.deletedAt === null) return existing.id;
  }
  const db = getDatabase();
  const [root] = await db
    .select({ id: pages.id })
    .from(pages)
    .where(
      and(
        eq(pages.workspaceId, workspaceId),
        eq(pages.spaceId, stream.spaceId),
        eq(pages.path, `/${DEVELOPMENT_PAGE_SLUG}`),
        isNull(pages.deletedAt),
      ),
    )
    .limit(1);
  const rootId =
    root?.id ??
    (
      await createPage({
        workspaceId,
        spaceId: stream.spaceId,
        actor,
        title: labels.rootTitle,
        body: labels.rootBody,
        kind: 'technical',
        slug: DEVELOPMENT_PAGE_SLUG,
      })
    ).id;
  const page = await createPage({
    workspaceId,
    spaceId: stream.spaceId,
    actor,
    title: labels.pageTitle(stream.ref ?? stream.title),
    body: labels.pageBody(stream.goal),
    kind: 'technical',
    parentId: rootId,
  });
  await updateStream(workspaceId, streamId, actor, { docsPageId: page.id });
  return page.id;
}

/* ------------------------------------------------------------------ */
/* Repository sync                                                     */
/* ------------------------------------------------------------------ */

/** A branch already merged when first seen counts as recent work this long; older ones are history. */
export const RECENT_MERGE_DAYS = 30;

export interface SyncResult {
  defaultBranch: string;
  created: string[];
  /** Branches already merged long before they were first seen: not made into streams. */
  skippedHistory: number;
  merged: string[];
  gone: string[];
}

/**
 * Reads the branches of the space's repository and brings the streams in line:
 * a stream for every branch that has none, each stream's branch snapshot
 * refreshed, streams whose branch reached the default branch marked merged,
 * and streams whose branch disappeared flagged as such — never deleted.
 */
export async function syncStreams(workspaceId: string, spaceId: string, actor: PageActor): Promise<SyncResult> {
  const space = await requireSpace(workspaceId, spaceId);
  const settings = readRepositorySettings(space.settings);
  if (!settings) throw new PageServiceError('validation', 'This space has no repository; link one in its settings first');

  const { defaultBranch, branches } = await withRepositoryLock(space.id, async () => {
    const dir = await syncRepository(space.id, settings);
    return listBranches(dir, settings);
  });

  const now = new Date();
  const existing = await listStreams(workspaceId, spaceId);
  const byRef = new Map(existing.filter((stream) => stream.ref).map((stream) => [stream.ref as string, stream]));
  const result: SyncResult = { defaultBranch, created: [], skippedHistory: 0, merged: [], gone: [] };
  const seen = new Set<string>();

  for (const branch of branches) {
    if (branch.name === defaultBranch) continue;
    seen.add(branch.name);
    const snapshot: DevStreamBranch = {
      commit: branch.commit,
      committed_at: branch.committedAt,
      subject: branch.subject,
      ahead: branch.ahead,
      behind: branch.behind,
      merged: branch.merged,
      present: true,
      default_branch: defaultBranch,
      synced_at: now.toISOString(),
    };
    const stream = byRef.get(branch.name);
    if (!stream) {
      // A branch merged long ago is history, not work, and a first sync of an
      // old repository would otherwise bury the overview in it. A recently
      // merged one is recorded as merged, so it shows up in "merged, no
      // release" until somebody files it under one.
      const committed = Date.parse(branch.committedAt);
      if (branch.merged && (!Number.isFinite(committed) || now.getTime() - committed > RECENT_MERGE_DAYS * 86_400_000)) {
        result.skippedHistory += 1;
        continue;
      }
      const created = await createStream(workspaceId, spaceId, actor, {
        title: branch.name,
        ref: branch.name,
        state: branch.merged ? 'merged' : 'active',
      });
      await getDatabase().update(devStreams).set({ branch: snapshot }).where(eq(devStreams.id, created.id));
      result.created.push(branch.name);
      continue;
    }
    const becameMerged = branch.merged && stream.state !== 'merged' && stream.state !== 'dropped';
    await getDatabase()
      .update(devStreams)
      .set({
        branch: snapshot,
        ...(becameMerged ? { state: 'merged' as const, mergedAt: now, updatedAt: now } : {}),
      })
      .where(eq(devStreams.id, stream.id));
    if (becameMerged) result.merged.push(branch.name);
  }

  for (const stream of existing) {
    if (!stream.ref || seen.has(stream.ref) || stream.branch?.present === false || stream.ref === defaultBranch) continue;
    await getDatabase()
      .update(devStreams)
      .set({ branch: { ...(stream.branch ?? emptySnapshot(defaultBranch, now)), present: false, synced_at: now.toISOString() } })
      .where(eq(devStreams.id, stream.id));
    result.gone.push(stream.ref);
  }

  await recordAudit({
    workspaceId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'stream.synced',
    target: spaceId,
    metadata: { created: result.created.length, merged: result.merged.length, gone: result.gone.length },
  });
  return result;
}

function emptySnapshot(defaultBranch: string, now: Date): DevStreamBranch {
  return { commit: '', committed_at: '', subject: '', ahead: 0, behind: 0, merged: false, present: false, default_branch: defaultBranch, synced_at: now.toISOString() };
}

/* ------------------------------------------------------------------ */
/* Releases                                                            */
/* ------------------------------------------------------------------ */

export async function createRelease(
  workspaceId: string,
  spaceId: string,
  actor: PageActor,
  input: { name: string; dueOn?: string | null; notes?: string },
): Promise<ReleaseRecord> {
  await requireSpace(workspaceId, spaceId);
  const dueOn = input.dueOn?.trim() || null;
  if (dueOn !== null && !DATE.test(dueOn)) throw new PageServiceError('validation', 'A due date is YYYY-MM-DD');
  try {
    return await getDatabase().transaction(async (tx) => {
      const [row] = await tx
        .insert(devReleases)
        .values({ workspaceId, spaceId, name: cleanReleaseName(input.name), dueOn, notes: (input.notes ?? '').trim().slice(0, 5000) })
        .returning(releaseColumns);
      if (!row) throw new PageServiceError('conflict', 'The release could not be created');
      await recordAudit(
        { workspaceId, actorType: actor.type, actorId: actor.id, action: 'release.created', target: row.id, metadata: { name: row.name } },
        tx,
      );
      return row as ReleaseRecord;
    });
  } catch (error) {
    if (uniqueRefConflict(error)) throw new PageServiceError('conflict', 'A release with this name already exists');
    throw error;
  }
}

/**
 * Marks a release shipped. Refused while any of its streams has not reached
 * the default branch, unless `force` — and then the streams left out are
 * named in the audit, so "we shipped without X" is on record.
 */
export async function shipRelease(
  workspaceId: string,
  releaseId: string,
  actor: PageActor,
  force: boolean,
): Promise<{ release: ReleaseRecord; missing: string[] }> {
  const db = getDatabase();
  const [release] = await db
    .select(releaseColumns)
    .from(devReleases)
    .where(and(eq(devReleases.workspaceId, workspaceId), eq(devReleases.id, releaseId)))
    .limit(1);
  if (!release) throw new PageServiceError('not_found', 'Release not found');
  const streams = (await listStreams(workspaceId, release.spaceId)).filter(
    (stream) => stream.releaseId === release.id && stream.state !== 'dropped',
  );
  const missing = streams.filter((stream) => !isMerged(stream)).map((stream) => stream.title);
  if (missing.length > 0 && !force) {
    throw new PageServiceError('conflict', 'Some streams of this release have not reached the default branch', { missing });
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(devReleases)
      .set({ state: 'shipped', shippedAt: new Date() })
      .where(eq(devReleases.id, release.id))
      .returning(releaseColumns);
    await recordAudit(
      { workspaceId, actorType: actor.type, actorId: actor.id, action: 'release.shipped', target: release.id, metadata: { name: release.name, missing } },
      tx,
    );
    return { release: (row ?? release) as ReleaseRecord, missing };
  });
}

/** Problems of a stream: its discussions, open first. */
export async function listStreamProblems(workspaceId: string, streamId: string) {
  return getDatabase()
    .select({
      id: discussions.id,
      title: discussions.title,
      status: discussions.status,
      openedByLabel: discussions.openedByLabel,
      lastActivityAt: discussions.lastActivityAt,
      decisionPageId: discussions.decisionPageId,
    })
    .from(discussions)
    .where(and(eq(discussions.workspaceId, workspaceId), eq(discussions.streamId, streamId)))
    .orderBy(sql`${discussions.status} = 'open' desc`, desc(discussions.lastActivityAt));
}
