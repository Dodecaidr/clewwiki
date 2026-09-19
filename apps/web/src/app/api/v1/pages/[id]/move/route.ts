import { z } from 'zod';

import { apiError, apiJson, readJsonBody, serviceErrorResponse, validationError } from '@/lib/api-response';
import { requireSpace, requireWorkspace } from '@/lib/api-auth';
import { authorizePagesRequest, DELETE_SCOPES } from '@/lib/pages-api';
import { getPageById, movePageToSpace } from '@/lib/pages/service';
import { toPageResource } from '@/lib/pages/serialize';
import { resolveSpaceParam } from '@/lib/spaces/access';
import { spaceKeyParamSchema } from '@/lib/spaces/keys';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

const bodySchema = z
  .object({
    space: spaceKeyParamSchema,
    parent_id: z.uuid().nullish(),
    parent_path: z.string().min(1).max(512).optional(),
  })
  .refine((value) => !(typeof value.parent_id === 'string' && value.parent_path !== undefined), {
    message: 'Give parent_id or parent_path, not both',
    path: ['parent_path'],
  });

/**
 * Moves a page, with everything below it, into another space.
 *
 * For the space it leaves this is a subtree delete, and it is scoped like one:
 * an agent token needs `pages:delete` on top of `pages:write`. The caller has to
 * be able to see both spaces — a target it cannot see is `404 Space not found`,
 * whether it is hidden or missing. A move inside a space stays what it was, a
 * `PATCH` with `parent_id` or `path`.
 *
 * `conflict` covers everything that stops a move without being the caller's
 * mistake: somebody else's live claim in the subtree, a path already taken in
 * the target, an archived target, and a page the source space still uses as its
 * home, its rules or the parent of its decisions.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorizePagesRequest(request, DELETE_SCOPES);
  if (!auth.ok) return auth.response;

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return apiError(404, 'not_found', 'Page not found');

  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch {
    return apiError(400, 'validation', 'Request body is not valid JSON');
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  try {
    const existing = await getPageById(auth.workspaceId, parsedParams.data.id);
    if (!existing) return apiError(404, 'not_found', 'Page not found');

    const mismatch = requireWorkspace(auth.identity, existing.workspaceId);
    if (mismatch) return mismatch;
    const hidden = requireSpace(auth.identity, existing.spaceId);
    if (hidden) return apiError(404, 'not_found', 'Page not found');

    const target = await resolveSpaceParam(auth.identity, parsed.data.space);
    if (!target.ok) return target.response;

    const result = await movePageToSpace({
      workspaceId: auth.workspaceId,
      pageId: existing.id,
      actor: auth.actor,
      targetSpaceId: target.space.id,
      parentId: parsed.data.parent_id,
      parentPath: parsed.data.parent_path,
    });

    return apiJson(
      {
        // Nothing about the content changed, so the body is left out.
        page: toPageResource(result.page, target.space, { includeBody: false }),
        previous_path: result.previousPath,
        pages_moved: result.moved,
        unlinked_page_ids: result.unlinked,
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
