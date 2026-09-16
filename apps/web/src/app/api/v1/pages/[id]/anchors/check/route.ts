import { z } from 'zod';

import { apiError, apiJson, serviceErrorResponse, validationError } from '@/lib/api-response';
import { requireWorkspace } from '@/lib/api-auth';
import { checkPageAnchors } from '@/lib/anchors/service';
import { toAnchorResource, toFallbackShareResource } from '@/lib/anchors/serialize';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';
import { getPageById } from '@/lib/pages/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });
const querySchema = z.object({ ref: z.string().trim().min(1).max(200).optional() });

/**
 * Recomputes a page's anchors against the current state of the repository.
 *
 * `pages:read`, not `pages:write`: the caller is asking a question about code,
 * and the only thing written is the answer — the recomputed state on the
 * anchor rows, plus one audit row saying who asked and what came back. No page
 * is touched, and nothing is re-anchored automatically.
 *
 * `fallback_share` rides along on purpose. It is the workspace-wide share of
 * anchors sitting on the line-range path, and it is the number that says when
 * these states are about to stop being worth believing.
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

    const result = await checkPageAnchors({
      workspaceId: auth.workspaceId,
      pageId: page.id,
      actor: auth.actor,
      workspaceSettings: auth.identity.workspace.settings,
      ref: parsedQuery.data.ref,
    });

    return apiJson(
      {
        page_id: page.id,
        checked_at: result.checkedAt.toISOString(),
        ref: result.ref,
        commit: result.commit,
        anchors: result.anchors.map(toAnchorResource),
        fallback_share: toFallbackShareResource(result.fallbackShare),
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
