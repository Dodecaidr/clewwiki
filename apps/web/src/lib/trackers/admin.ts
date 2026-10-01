import 'server-only';

import { randomBytes } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { workspaces } from '@clewwiki/db';
import type { TrackerSettings } from '@clewwiki/db';

import { recordAudit } from '../audit';
import { getDatabase } from '../db';
import { MAX_TRACKERS, TrackerSettingsError, normalizeTracker } from './settings';
import type { TrackerInput } from './settings';

/** Rewrites the organization's tracker list under a row lock, so two admins' edits do not lose one. */
async function rewrite(
  workspaceId: string,
  adminId: string,
  change: (list: TrackerSettings[]) => TrackerSettings[],
  audit: { action: string; metadata: Record<string, unknown> },
): Promise<void> {
  await getDatabase().transaction(async (tx) => {
    const [row] = await tx
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .for('update');
    if (!row) return;
    const next = change(Array.isArray(row.settings.trackers) ? row.settings.trackers : []);
    await tx
      .update(workspaces)
      .set({ settings: sql`${workspaces.settings} || ${JSON.stringify({ trackers: next })}::jsonb` })
      .where(eq(workspaces.id, workspaceId));
    await recordAudit(
      { workspaceId, actorType: 'user', actorId: adminId, action: audit.action, target: workspaceId, metadata: audit.metadata },
      tx,
    );
  });
}

export async function addTracker(workspaceId: string, adminId: string, input: TrackerInput): Promise<TrackerSettings> {
  const tracker = normalizeTracker(input, randomBytes(6).toString('hex'));
  await rewrite(
    workspaceId,
    adminId,
    (list) => {
      if (list.length >= MAX_TRACKERS) throw new TrackerSettingsError('tooMany');
      // A project prefix belongs to one tracker; the newer one takes it over.
      const others = list.map((entry) => ({
        ...entry,
        projects: entry.projects.filter((project) => !tracker.projects.includes(project)),
      }));
      return [...others.filter((entry) => entry.projects.length > 0), tracker];
    },
    // The token's variable name is logged, never a value: there is no value here.
    { action: 'trackers.added', metadata: { name: tracker.name, kind: tracker.kind, base_url: tracker.base_url } },
  );
  return tracker;
}

export async function removeTracker(workspaceId: string, adminId: string, trackerId: string): Promise<void> {
  await rewrite(workspaceId, adminId, (list) => list.filter((entry) => entry.id !== trackerId), {
    action: 'trackers.removed',
    metadata: { id: trackerId },
  });
}
