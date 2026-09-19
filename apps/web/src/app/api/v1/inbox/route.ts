import { z } from 'zod';

import { apiJson, serviceErrorResponse, validationError } from '@/lib/api-response';
import { toInboxResource } from '@/lib/inbox/serialize';
import { INBOX_MAX_LIMIT, getInbox } from '@/lib/inbox/service';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(INBOX_MAX_LIMIT).optional(),
  unread: z.enum(['true', 'false']).optional(),
});

/**
 * The caller's inbox: what others said or decided, since the caller last
 * looked, about things the caller had a hand in.
 *
 * `pages:read` and no new scope, for the reason discussions have none: it shows
 * nothing the token could not already read, one endpoint at a time. It is the
 * caller's own — there is no parameter that names somebody else — and it is
 * read under the caller's current visibility, so a space that was closed to
 * them since contributes nothing.
 */
export async function GET(request: Request) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return validationError(parsed.error);

  try {
    const inbox = await getInbox({
      workspaceId: auth.workspaceId,
      actor: auth.actor,
      spaceIds: auth.identity.spaceIds,
      limit: parsed.data.limit,
      unreadOnly: parsed.data.unread === 'true',
    });
    return apiJson(toInboxResource(inbox), auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
