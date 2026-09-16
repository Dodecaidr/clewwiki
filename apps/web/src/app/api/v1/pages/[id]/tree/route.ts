import { z } from 'zod';

import { apiError, apiJson, serviceErrorResponse } from '@/lib/api-response';
import { getStaleAnchorCounts } from '@/lib/anchors/service';
import { getActiveClaimsByPage } from '@/lib/claims/service';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';
import { getPageTree } from '@/lib/pages/service';
import { toTreeResource } from '@/lib/pages/serialize';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

/**
 * The subtree rooted at one page, nested, without bodies.
 *
 * The page itself heads the answer so that "this page has no children" reads
 * differently from "there is no such page" — the latter is a 404.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return apiError(404, 'not_found', 'Page not found');

  try {
    const nodes = await getPageTree(auth.workspaceId, parsed.data.id);
    const [claims, staleAnchors] = await Promise.all([
      getActiveClaimsByPage(auth.workspaceId),
      getStaleAnchorCounts(auth.workspaceId),
    ]);
    const claimed = new Set(claims.keys());
    return apiJson(
      { nodes: nodes.map((node) => toTreeResource(node, claimed, staleAnchors)) },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
