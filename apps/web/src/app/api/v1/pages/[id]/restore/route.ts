import { z } from 'zod';

import { apiError, apiJson, serviceErrorResponse } from '@/lib/api-response';
import { authenticateRequest } from '@/lib/api-auth';
import { actorOf, isWorkspaceAdmin } from '@/lib/pages-api';
import { restorePage } from '@/lib/pages/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

/**
 * Restores a soft-deleted page and the subtree deleted with it.
 *
 * An administrator's act, not a scope: an agent token carries scopes but no
 * role, so no token can undo a delete however it is scoped — the same rule
 * force-releasing a claim follows. A path that a live page has taken since, a
 * deleted parent or a parent that has moved answers `conflict`.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(request);
  if (!auth.ok) return auth.response;

  if (!isWorkspaceAdmin(auth.identity)) {
    return apiError(403, 'forbidden', 'Only a workspace administrator can restore a page');
  }

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return apiError(404, 'not_found', 'Page not found');

  try {
    // The workspace is in the service's SQL predicate: a page from another
    // workspace is not found rather than forbidden.
    const result = await restorePage({
      workspaceId: auth.identity.workspaceId,
      pageId: parsed.data.id,
      actor: actorOf(auth.identity),
    });
    return apiJson(
      { page_id: parsed.data.id, restored: true, pages_restored: result.restored, path: result.path },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
