import { z } from 'zod';

import { apiError, apiJson, readJsonBody, serviceErrorResponse, validationError } from '@/lib/api-response';
import { markInboxRead } from '@/lib/inbox/service';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ up_to: z.iso.datetime({ offset: true }).optional() }).strict();

/**
 * Marks the inbox read up to a moment — by default, now.
 *
 * `up_to` exists for a caller that read the inbox a while ago and is only now
 * done with it: passing the `at` of the newest item it handled leaves whatever
 * arrived in between unread. The mark only moves forward.
 *
 * `pages:read` is enough. The only thing this writes is the caller's own
 * bookmark, and a read-only agent needs a bookmark as much as any other.
 */
export async function POST(request: Request) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch {
    return apiError(400, 'validation', 'Request body is not valid JSON');
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  try {
    const seenAt = await markInboxRead(
      auth.workspaceId,
      auth.actor,
      parsed.data.up_to === undefined ? new Date() : new Date(parsed.data.up_to),
    );
    return apiJson({ seen_at: seenAt.toISOString() }, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
