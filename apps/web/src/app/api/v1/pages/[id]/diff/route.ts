import { z } from 'zod';

import { apiError, apiJson, serviceErrorResponse, validationError } from '@/lib/api-response';
import { requireSpace, requireWorkspace } from '@/lib/api-auth';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';
import { getPageById } from '@/lib/pages/service';
import { toVersionDiffResource } from '@/lib/reviews/serialize';
import { diffPageVersions } from '@/lib/reviews/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });
const querySchema = z.object({
  from: z.coerce.number().int().min(0).max(2_147_483_647),
  to: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
  context: z.coerce.number().int().min(0).max(50).default(3),
});

/**
 * The difference between two versions of a page, as hunks of numbered lines.
 *
 * `from` may be 0 — "before the page existed" — and `to` defaults to the current
 * version, so `?from=N` answers "what has changed since version N".
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return apiError(404, 'not_found', 'Page not found');

  const parsedQuery = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsedQuery.success) return validationError(parsedQuery.error);

  try {
    const page = await getPageById(auth.workspaceId, parsedParams.data.id);
    if (!page) return apiError(404, 'not_found', 'Page not found');
    const mismatch = requireWorkspace(auth.identity, page.workspaceId);
    if (mismatch) return mismatch;
    const hidden = requireSpace(auth.identity, page.spaceId);
    if (hidden) return apiError(404, 'not_found', 'Page not found');

    const result = await diffPageVersions(
      auth.workspaceId,
      page.id,
      parsedQuery.data.from,
      parsedQuery.data.to ?? page.version,
      { context: parsedQuery.data.context },
    );
    return apiJson(toVersionDiffResource(result), auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
