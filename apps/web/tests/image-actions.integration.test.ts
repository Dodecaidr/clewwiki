import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';

const probe = await prepareTestDatabase();
if (!probe.reachable) console.warn(`[integration] skipping image action suite: ${probe.reason}`);

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';

const session: { current: Record<string, unknown> | null } = { current: null };
vi.mock('@/lib/session', async () => {
  const { sessionModuleMock } = await import('./helpers/session-mock');
  return sessionModuleMock(() => session.current);
});
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function png(seed: string): Uint8Array {
  const out = new Uint8Array(64);
  out.set(PNG, 0);
  out.set(new TextEncoder().encode(seed), 12);
  return out;
}

describe.skipIf(!probe.reachable)('removing an image from the page view', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  const tag = `imgact-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let openSpace = '';
  let hiddenSpace = '';

  const as = (userId: string, spaceIds: string[] | null) => {
    session.current = { userId, role: 'editor', workspace: { id: workspaceId }, workspaceId, spaceIds };
  };

  async function remove(imageId: string) {
    const { deleteImageAction } = await import('@/app/pages/image-actions');
    const form = new FormData();
    form.set('imageId', imageId);
    return deleteImageAction({}, form);
  }

  async function imageOn(spaceId: string, uploader: string, attached: boolean, seed: string): Promise<string> {
    const { createPage } = await import('@/lib/pages/service');
    const { storeImage } = await import('@/lib/images/service');
    const actor = { type: 'user' as const, id: uploader };
    const page = attached
      ? await createPage({ workspaceId, spaceId, actor, title: `Page ${seed}`, body: 'text\n', kind: 'human' } as never)
      : null;
    const stored = await storeImage({ workspaceId, spaceId, pageId: page?.id ?? null, actor, bytes: png(seed) });
    return stored.image.id;
  }

  const exists = async (imageId: string) => {
    const { getImageAccess } = await import('@/lib/images/service');
    return (await getImageAccess(workspaceId, imageId)) !== null;
  };

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    db = schema.getDatabase();
    const [workspace] = await db.insert(schema.workspaces).values({ name: tag, slug: tag }).returning();
    workspaceId = workspace!.id;
    const [open] = await db.insert(schema.spaces).values({ workspaceId, key: 'OPEN', name: 'Open' }).returning();
    const [hidden] = await db.insert(schema.spaces).values({ workspaceId, key: 'HID', name: 'Hidden', restricted: true }).returning();
    openSpace = open!.id;
    hiddenSpace = hidden!.id;
  });

  afterAll(async () => {
    if (!probe.reachable) return;
    const { eq } = await import('drizzle-orm');
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  });

  it('removes an image of a page the person can see, whoever uploaded it', async () => {
    const imageId = await imageOn(openSpace, 'someone-else', true, 'visible');
    as('reader', [openSpace]);
    expect(await remove(imageId)).toEqual({});
    expect(await exists(imageId)).toBe(false);
  });

  it('reports an image in a space the person cannot see as missing, and leaves it', async () => {
    const imageId = await imageOn(hiddenSpace, 'member', true, 'hidden');
    as('outsider', [openSpace]);
    expect(await remove(imageId)).toEqual({ error: 'not_found' });
    expect(await exists(imageId)).toBe(true);
  });

  it('keeps an image no page has claimed to its uploader', async () => {
    const imageId = await imageOn(openSpace, 'author', false, 'waiting');
    as('colleague', null);
    expect(await remove(imageId)).toEqual({ error: 'not_found' });
    expect(await exists(imageId)).toBe(true);
    as('author', null);
    expect(await remove(imageId)).toEqual({});
  });

  it('needs a session, and an id that is one', async () => {
    const imageId = await imageOn(openSpace, 'author', true, 'guarded');
    session.current = null;
    expect(await remove(imageId)).toEqual({ error: 'forbidden' });
    as('author', null);
    expect(await remove('not-an-id')).toEqual({ error: 'not_found' });
    expect(await exists(imageId)).toBe(true);
  });
});
