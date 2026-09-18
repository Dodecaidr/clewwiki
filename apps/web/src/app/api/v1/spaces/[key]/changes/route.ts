import { z } from 'zod';

import { apiError, apiJson, serviceErrorResponse, validationError } from '@/lib/api-response';
import { requireWorkspace } from '@/lib/api-auth';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';
import { toChangeResource } from '@/lib/reviews/serialize';
import { listChanges } from '@/lib/reviews/service';
import { resolveSpaceParam } from '@/lib/spaces/access';
import { spaceKeyParamSchema } from '@/lib/spaces/keys';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ key: string }> };

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().min(1).max(100).optional(),
  author: z.enum(['user', 'agent']).optional(),
});

/**
 * The change feed of one space: every revision of its pages, newest first, with
 * who wrote it and what became of it (`review_status`).
 *
 * `pages:read`, space-restricted, and no new scope: the feed says nothing a
 * caller could not learn by reading the version history of each page it may
 * already read. An agent can use it to find out that its change was reverted.
 *
 * Bodies are not included; `/pages/{id}/diff` is how a change is looked at.
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const key = spaceKeyParamSchema.safeParse((await context.params).key);
  if (!key.success) return apiError(404, 'not_found', 'Space not found');

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return validationError(parsed.error);

  try {
    const resolved = await resolveSpaceParam(auth.identity, key.data);
    if (!resolved.ok) return resolved.response;
    const mismatch = requireWorkspace(auth.identity, resolved.space.workspaceId);
    if (mismatch) return mismatch;

    const changes = await listChanges(auth.workspaceId, resolved.space.id, {
      limit: parsed.data.limit,
      before: parsed.data.before ?? null,
      authorType: parsed.data.author,
    });
    const last = changes[changes.length - 1];
    return apiJson(
      {
        space: { key: resolved.space.key, name: resolved.space.name },
        changes: changes.map(toChangeResource),
        // Present only when the page was full, so a client stops without an
        // extra request that returns nothing.
        next_before: changes.length === parsed.data.limit && last ? last.cursor : null,
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
