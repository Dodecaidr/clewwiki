import { apiJson, serviceErrorResponse } from '@/lib/api-response';
import { getPresence } from '@/lib/claims/service';
import { toPresenceResource } from '@/lib/claims/serialize';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';

export const dynamic = 'force-dynamic';

/**
 * The presence board: who is working on what in this workspace right now.
 *
 * Every active claim, with its holder, its target, since when it has been held,
 * when it lapses, and the notes hanging on it. Scoped to the caller's workspace
 * in the query itself, and readable with `pages:read` — knowing that a page is
 * spoken for is not a write.
 */
export async function GET(request: Request) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  try {
    const presence = await getPresence(auth.workspaceId);
    return apiJson({ claims: presence.map(toPresenceResource) }, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
