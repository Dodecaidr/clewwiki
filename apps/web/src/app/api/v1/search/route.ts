import { z } from 'zod';

import { apiJson, serviceErrorResponse, validationError } from '@/lib/api-response';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';
import { searchPages } from '@/lib/pages/service';
import { toSearchHitResource } from '@/lib/pages/serialize';
import { resolveSpaceParam, visibleSpaces } from '@/lib/spaces/access';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  q: z.string().trim().min(1).max(500),
  space: z.string().min(1).max(20).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  kind: z.enum(['technical', 'human', 'any']).default('any'),
});

/**
 * Full-text search in one space (`?space=KEY`) or across every unarchived space
 * the caller can see.
 *
 * Snippets come back as plain text with no markup: the source of a snippet is
 * stored page content, and wrapping it in tags on the way out would invite a
 * consumer to render it as markup. The result is data about a page, not a
 * fragment of document to display unescaped.
 */
export async function GET(request: Request) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return validationError(parsed.error);

  try {
    let spaceIds: string[];
    if (parsed.data.space) {
      const resolved = await resolveSpaceParam(auth.identity, parsed.data.space);
      if (!resolved.ok) return resolved.response;
      spaceIds = [resolved.space.id];
    } else {
      spaceIds = (await visibleSpaces(auth.identity)).map((space) => space.id);
    }

    const hits = await searchPages(auth.workspaceId, {
      query: parsed.data.q,
      spaceIds,
      limit: parsed.data.limit,
      kind: parsed.data.kind === 'any' ? undefined : parsed.data.kind,
    });

    return apiJson({ query: parsed.data.q, results: hits.map(toSearchHitResource) }, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
