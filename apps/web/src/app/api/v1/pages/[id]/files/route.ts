import { z } from 'zod';

import { apiError, apiJson, serviceErrorResponse } from '@/lib/api-response';
import { requireSpace, requireWorkspace } from '@/lib/api-auth';
import { toFileResource } from '@/lib/files/api';
import { listPageFiles } from '@/lib/files/service';
import { filesEnabled } from '@/lib/files/store';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';
import { getPageById } from '@/lib/pages/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });
type RouteContext = { params: Promise<{ id: string }> };

/**
 * The files attached to a page, by name, each with its latest version. Listed
 * even while uploads are switched off, so that what was attached before stays
 * findable; `uploads_enabled` says which it is.
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return apiError(404, 'not_found', 'Page not found');

  try {
    const page = await getPageById(auth.workspaceId, parsed.data.id);
    if (!page) return apiError(404, 'not_found', 'Page not found');
    const mismatch = requireWorkspace(auth.identity, page.workspaceId);
    if (mismatch) return mismatch;
    if (requireSpace(auth.identity, page.spaceId)) return apiError(404, 'not_found', 'Page not found');

    const files = await listPageFiles(auth.workspaceId, page.id);
    return apiJson(
      { page_id: page.id, uploads_enabled: filesEnabled(), files: files.map(toFileResource) },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
