import { z } from 'zod';

import { apiError, apiJson, serviceErrorResponse, validationError } from '@/lib/api-response';
import { requireWorkspace } from '@/lib/api-auth';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';
import { toPendingPageResource } from '@/lib/reviews/serialize';
import { listPendingPages } from '@/lib/reviews/service';
import { resolveSpaceParam } from '@/lib/spaces/access';
import { spaceKeyParamSchema } from '@/lib/spaces/keys';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ key: string }> };

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * The pages of a space with agent changes that no person has looked at yet,
 * most recently changed first.
 *
 * One entry per page, not per revision: an agent that wrote a page four times
 * produced one thing to read, and the entry says what it is compared against
 * (`baseline_version`) and how much changed.
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

    const pending = await listPendingPages(auth.workspaceId, resolved.space.id, parsed.data.limit);
    return apiJson(
      {
        space: { key: resolved.space.key, name: resolved.space.name },
        pending: pending.map(toPendingPageResource),
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
