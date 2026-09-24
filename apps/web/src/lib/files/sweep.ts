import 'server-only';

import { sql } from 'drizzle-orm';
import { blobKey } from '@clewwiki/files';

import { getDatabase } from '../db';
import { getFileStore } from './store';

/** How long a blob no version refers to is kept before it is removed. */
export const UNREFERENCED_BLOB_TTL_MS = 60 * 60 * 1000;
/** How long an upload may sit in the staging area before it counts as abandoned. */
export const STAGED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
/** How old a blob with no row at all must be before it is taken for an orphan. */
export const ORPHAN_BLOB_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Removes the bytes nobody needs any more: blobs no file version and no
 * import waiting for review refers to, once they have been left alone for an hour, and uploads a process that died
 * part-way left in the staging area.
 *
 * Each blob is removed under its row's lock, and only if it is still
 * unreferenced and untouched once the lock is held. An upload of the same bytes
 * touches that row before it writes them, so it either got there first — and
 * the blob stays — or waits here and writes the bytes again after.
 *
 * Kept apart from the file service because start-up code schedules it.
 */
export async function sweepFileBlobs(
  now: Date = new Date(),
): Promise<{ removed: number; staged: number; orphans: number }> {
  const store = getFileStore();
  if (store === null) return { removed: 0, staged: 0, orphans: 0 };

  const cutoff = new Date(now.getTime() - UNREFERENCED_BLOB_TTL_MS).toISOString();
  const unreferenced = sql`
    file_blobs.touched_at < ${cutoff}::timestamptz
    and not exists (
      select 1 from page_file_versions v
      where v.workspace_id = file_blobs.workspace_id and v.sha256 = file_blobs.sha256
    )
    and not exists (
      select 1 from import_file_versions i
      where i.workspace_id = file_blobs.workspace_id and i.sha256 = file_blobs.sha256
    )`;

  const candidates = await getDatabase().execute<{ workspace_id: string; sha256: string }>(
    sql`select workspace_id, sha256 from file_blobs where ${unreferenced} limit 500`,
  );

  let removed = 0;
  for (const candidate of candidates) {
    const gone = await getDatabase().transaction(async (tx) => {
      const locked = await tx.execute<{ sha256: string }>(
        sql`select sha256 from file_blobs
            where workspace_id = ${candidate.workspace_id} and sha256 = ${candidate.sha256} and ${unreferenced}
            for update skip locked`,
      );
      if (locked.length === 0) return false;
      await store.remove(blobKey(candidate.workspace_id, candidate.sha256));
      await tx.execute(
        sql`delete from file_blobs where workspace_id = ${candidate.workspace_id} and sha256 = ${candidate.sha256}`,
      );
      return true;
    });
    if (gone) removed += 1;
  }

  const staged = await store.sweepStaging(STAGED_UPLOAD_TTL_MS, now);
  const orphans = await sweepOrphanBlobs(now);
  return { removed, staged, orphans };
}

/**
 * Removes blobs the database has no row for: bytes written by a transaction
 * that then rolled back. They are rare — the blob is linked just before the
 * version row is written — and invisible to the sweep above, which starts
 * from rows.
 *
 * The same protocol holds here: the sweep claims the blob by inserting its row
 * first. An upload of the same bytes that has written its own row, committed
 * or not, makes that insert wait and then conflict, and the blob is left to
 * it; an upload that comes after waits on the sweep's row and writes the
 * bytes again.
 */
async function sweepOrphanBlobs(now: Date): Promise<number> {
  const store = getFileStore();
  if (store === null) return 0;
  const keys = await store.listOldKeys(ORPHAN_BLOB_TTL_MS, 500, now);
  let removed = 0;
  for (const key of keys) {
    const [workspaceId, , sha256] = key.split('/');
    if (!workspaceId || !sha256) continue;
    try {
      const gone = await getDatabase().transaction(async (tx) => {
        const claimed = await tx.execute<{ sha256: string }>(
          sql`insert into file_blobs (workspace_id, sha256, byte_size, touched_at)
              values (${workspaceId}, ${sha256}, 0, 'epoch')
              on conflict do nothing
              returning sha256`,
        );
        if (claimed.length === 0) return false;
        await store.remove(key);
        await tx.execute(sql`delete from file_blobs where workspace_id = ${workspaceId} and sha256 = ${sha256}`);
        return true;
      });
      if (gone) removed += 1;
    } catch {
      // A workspace that no longer exists refuses the row; its bytes are
      // nobody's, and go.
      const exists = await getDatabase().execute(sql`select 1 from workspaces where id = ${workspaceId}`);
      if (exists.length === 0) {
        await store.remove(key);
        removed += 1;
      }
    }
  }
  return removed;
}
