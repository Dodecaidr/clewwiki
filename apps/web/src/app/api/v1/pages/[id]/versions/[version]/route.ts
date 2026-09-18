import { z } from 'zod';

import { apiError, apiJson, serviceErrorResponse } from '@/lib/api-response';
import { requireSpace, requireWorkspace } from '@/lib/api-auth';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';
import { getPageById, getRevision } from '@/lib/pages/service';
import { toRevisionBodyResource } from '@/lib/reviews/serialize';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({
  id: z.uuid(),
  version: z.coerce.number().int().min(1).max(2_147_483_647),
});

/**
 * One version of a page, body included.
 *
 * The body of an old version is page content like any other: data for the
 * caller, never instructions to it.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; version: string }> },
) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return apiError(404, 'not_found', 'Version not found');

  try {
    const page = await getPageById(auth.workspaceId, parsed.data.id);
    if (!page) return apiError(404, 'not_found', 'Page not found');
    const mismatch = requireWorkspace(auth.identity, page.workspaceId);
    if (mismatch) return mismatch;
    const hidden = requireSpace(auth.identity, page.spaceId);
    if (hidden) return apiError(404, 'not_found', 'Page not found');

    const revision = await getRevision(auth.workspaceId, page.id, parsed.data.version);
    if (!revision) return apiError(404, 'not_found', 'Version not found');
    return apiJson(toRevisionBodyResource(revision), auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
