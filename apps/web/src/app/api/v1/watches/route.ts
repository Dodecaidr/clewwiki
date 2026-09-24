import { z } from 'zod';

import { apiCreated, apiError, apiJson, readJsonBody, serviceErrorResponse, validationError } from '@/lib/api-response';
import { listWatches, resolveWatchTarget, unwatch, watch } from '@/lib/files/watches';
import type { RequestedWatchTarget, WatchRecord } from '@/lib/files/watches';
import { actorOf, authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';

export const dynamic = 'force-dynamic';

/**
 * Watching pages and spaces for new versions of their files.
 *
 * Watching only reads — it changes nothing anybody else sees — so it needs
 * `pages:read`, and a viewer may watch. What a watch produces arrives in the
 * inbox, under the watcher's visibility at the time it is read.
 */

const targetSchema = z.union([
  z.object({ page_id: z.uuid() }).strict(),
  z.object({ space: z.string().regex(/^[A-Za-z0-9]{2,10}$/, 'A space key is 2 to 10 letters or digits') }).strict(),
]);

type TargetBody = z.infer<typeof targetSchema>;

function requestedTarget(body: TargetBody): RequestedWatchTarget {
  return 'page_id' in body ? { kind: 'page', id: body.page_id } : { kind: 'space', key: body.space.toUpperCase() };
}

function describeTarget(body: TargetBody): Record<string, string> {
  return 'page_id' in body ? { page_id: body.page_id } : { space: body.space.toUpperCase() };
}

function toWatchResource(record: WatchRecord): Record<string, unknown> {
  return {
    watch_id: record.id,
    kind: record.target.kind,
    page_id: record.target.kind === 'page' ? record.target.id : null,
    space: record.spaceKey,
    title: record.title,
    created_at: record.createdAt.toISOString(),
  };
}

/** What the caller watches, among what they can see now. */
export async function GET(request: Request) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;
  try {
    const records = await listWatches(auth.workspaceId, actorOf(auth.identity), auth.identity.spaceIds);
    return apiJson({ watches: records.map(toWatchResource) }, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/** Starts watching `{"page_id"}` or `{"space"}` (a key): `201`, or `200` if already watching. */
export async function POST(request: Request) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;
  try {
    const body = targetSchema.safeParse(await readJsonBody(request));
    if (!body.success) return validationError(body.error);
    const target = await resolveWatchTarget(auth.workspaceId, auth.identity.spaceIds, requestedTarget(body.data));
    const created = await watch(auth.workspaceId, actorOf(auth.identity), target);
    const resource = { watching: true, ...describeTarget(body.data) };
    return created ? apiCreated(resource, auth.headers) : apiJson(resource, auth.headers);
  } catch (error) {
    if (error instanceof SyntaxError) return apiError(400, 'validation', error.message);
    return serviceErrorResponse(error);
  }
}

/** Stops watching `{"page_id"}` or `{"space"}`. Stopping a watch that is not there is not an error. */
export async function DELETE(request: Request) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;
  try {
    const body = targetSchema.safeParse(await readJsonBody(request));
    if (!body.success) return validationError(body.error);
    // Stopping needs no sight of the target: a watch on a space one has lost
    // is still one's own to remove.
    const target = await resolveWatchTarget(auth.workspaceId, null, requestedTarget(body.data)).catch(() => null);
    const removed = target === null ? false : await unwatch(auth.workspaceId, actorOf(auth.identity), target);
    return apiJson({ watching: false, removed, ...describeTarget(body.data) }, auth.headers);
  } catch (error) {
    if (error instanceof SyntaxError) return apiError(400, 'validation', error.message);
    return serviceErrorResponse(error);
  }
}
