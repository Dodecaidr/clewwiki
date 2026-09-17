import { z } from 'zod';

import { apiError, apiJson, serviceErrorResponse, validationError } from '@/lib/api-response';
import { requireSpace, requireWorkspace } from '@/lib/api-auth';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';
import { getPageById, listRevisions } from '@/lib/pages/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });
const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

/**
 * The revision history of a page, newest first.
 *
 * Revisions carry the content hash of each version and the actor that wrote
 * it, so the history answers "who changed this, and to what" without a second
 * request. Bodies are not included: fetching a hundred of them to render a
 * list is not what a caller asking for history wants.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return apiError(404, 'not_found', 'Page not found');

  const parsedQuery = querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsedQuery.success) return validationError(parsedQuery.error);

  try {
    const page = await getPageById(auth.workspaceId, parsedParams.data.id);
    if (!page) return apiError(404, 'not_found', 'Page not found');
    const mismatch = requireWorkspace(auth.identity, page.workspaceId);
    if (mismatch) return mismatch;
    const hidden = requireSpace(auth.identity, page.spaceId);
    if (hidden) return apiError(404, 'not_found', 'Page not found');

    const revisions = await listRevisions(
      auth.workspaceId,
      parsedParams.data.id,
      parsedQuery.data.limit,
    );

    return apiJson(
      {
        page_id: parsedParams.data.id,
        versions: revisions.map((revision) => ({
          version: revision.version,
          title: revision.title,
          summary: revision.summary,
          content_hash: revision.contentHash,
          author: { type: revision.authorType, id: revision.authorId },
          created_at: revision.createdAt.toISOString(),
        })),
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
