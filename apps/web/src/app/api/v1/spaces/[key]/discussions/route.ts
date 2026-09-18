import { z } from 'zod';

import {
  apiCreated,
  apiError,
  apiJson,
  readJsonBody,
  serviceErrorResponse,
  validationError,
} from '@/lib/api-response';
import { requireWorkspace } from '@/lib/api-auth';
import {
  MAX_DISCUSSION_TITLE_LENGTH,
  MAX_MESSAGE_BYTES,
  listDiscussions,
  openDiscussion,
} from '@/lib/discussions/service';
import { toDiscussionResource, toDiscussionStub } from '@/lib/discussions/serialize';
import { toDiscussionMessageResource } from '@/lib/discussions/serialize';
import { authorizePagesRequest, READ_SCOPES, WRITE_SCOPES } from '@/lib/pages-api';
import { resolveSpaceParam } from '@/lib/spaces/access';
import { spaceKeyParamSchema } from '@/lib/spaces/keys';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ key: string }> };

const listQuerySchema = z.object({
  status: z.enum(['open', 'resolved']).optional(),
});

const openBodySchema = z
  .object({
    title: z.string().min(1).max(MAX_DISCUSSION_TITLE_LENGTH * 2),
    body: z.string().min(1).max(MAX_MESSAGE_BYTES * 2),
    page_id: z.uuid().nullish(),
    section_id: z.string().max(200).nullish(),
  })
  .strict();

/**
 * The discussions of one space.
 *
 * `pages:read`, space-restricted — the same scope as reading a page, and no new
 * one. A discussion is content of the space: it is written by the people and
 * agents who may write there, read by the ones who may read there, and its
 * whole purpose is to become a page. A `discussions:read` scope would mean
 * every token already issued has to be re-issued before an agent could take
 * part in a conversation about the pages it is already allowed to rewrite,
 * which buys nothing and costs every operator an afternoon.
 *
 * Expiry is applied before the listing is read, so a thread whose deadline has
 * passed is never shown one last time.
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const key = spaceKeyParamSchema.safeParse((await context.params).key);
  if (!key.success) return apiError(404, 'not_found', 'Space not found');

  const parsed = listQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return validationError(parsed.error);

  try {
    const resolved = await resolveSpaceParam(auth.identity, key.data);
    if (!resolved.ok) return resolved.response;
    const mismatch = requireWorkspace(auth.identity, resolved.space.workspaceId);
    if (mismatch) return mismatch;

    const found = await listDiscussions(auth.workspaceId, resolved.space.id, {
      status: parsed.data.status,
    });
    return apiJson(
      {
        space: { key: resolved.space.key, name: resolved.space.name },
        discussions: found.map((entry) => toDiscussionResource(entry, resolved.space)),
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/**
 * Opens a discussion with its first message. `pages:write`, for the same reason
 * the read needs `pages:read`.
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;

  const key = spaceKeyParamSchema.safeParse((await context.params).key);
  if (!key.success) return apiError(404, 'not_found', 'Space not found');

  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch {
    return apiError(400, 'validation', 'Request body is not valid JSON');
  }
  const parsed = openBodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  try {
    const resolved = await resolveSpaceParam(auth.identity, key.data);
    if (!resolved.ok) return resolved.response;
    const mismatch = requireWorkspace(auth.identity, resolved.space.workspaceId);
    if (mismatch) return mismatch;

    const result = await openDiscussion({
      workspaceId: auth.workspaceId,
      spaceId: resolved.space.id,
      actor: { ...auth.actor, label: auth.identity.name },
      title: parsed.data.title,
      body: parsed.data.body,
      pageId: parsed.data.page_id ?? null,
      sectionId: parsed.data.section_id ?? null,
    });

    return apiCreated(
      {
        ...toDiscussionStub(result.discussion, resolved.space),
        message: toDiscussionMessageResource(result.message),
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
