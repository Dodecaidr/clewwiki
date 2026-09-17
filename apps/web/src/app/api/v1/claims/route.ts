import { z } from 'zod';

import { apiJson, serviceErrorResponse, validationError } from '@/lib/api-response';
import { getPresence } from '@/lib/claims/service';
import { toPresenceResource } from '@/lib/claims/serialize';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';
import { resolveSpaceParam, visibleSpaces } from '@/lib/spaces/access';

export const dynamic = 'force-dynamic';

const querySchema = z.object({ space: z.string().min(1).max(20).optional() });

/**
 * The presence board: who is working on what right now.
 *
 * Every active claim, with its holder, its target and its space, since when it
 * has been held, when it lapses, and the notes hanging on it. `?space=KEY`
 * narrows it to one space; without it the board covers every space the caller
 * can see, including archived ones — a live lease is worth knowing about
 * wherever it is. Scoped to the caller's workspace in the query itself, and
 * readable with `pages:read`: knowing that a page is spoken for is not a write.
 */
export async function GET(request: Request) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return validationError(parsed.error);

  try {
    let spaceIds: string[] | null;
    if (parsed.data.space) {
      const resolved = await resolveSpaceParam(auth.identity, parsed.data.space);
      if (!resolved.ok) return resolved.response;
      spaceIds = [resolved.space.id];
    } else {
      spaceIds =
        auth.identity.spaceIds === null
          ? null
          : (await visibleSpaces(auth.identity, { includeArchived: true })).map((space) => space.id);
    }

    const presence = await getPresence(auth.workspaceId, { spaceIds });
    return apiJson({ claims: presence.map(toPresenceResource) }, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
