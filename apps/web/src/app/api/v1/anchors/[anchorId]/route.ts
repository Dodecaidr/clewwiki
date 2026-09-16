import { z } from 'zod';

import { apiError, apiJson, serviceErrorResponse } from '@/lib/api-response';
import { requireWorkspace } from '@/lib/api-auth';
import { deleteAnchor, getAnchorById } from '@/lib/anchors/service';
import { authorizePagesRequest, WRITE_SCOPES } from '@/lib/pages-api';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ anchorId: z.uuid() });

/**
 * Removes an anchor.
 *
 * Deleting the anchor is the right answer when the code it described is gone
 * for good — the page then says what it says on its own authority, rather than
 * carrying a `lost` badge nobody can clear.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ anchorId: string }> },
) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return apiError(404, 'not_found', 'Anchor not found');

  try {
    const existing = await getAnchorById(auth.workspaceId, parsed.data.anchorId);
    if (!existing) return apiError(404, 'not_found', 'Anchor not found');

    const mismatch = requireWorkspace(auth.identity, existing.workspaceId);
    if (mismatch) return mismatch;

    const removed = await deleteAnchor({
      workspaceId: auth.workspaceId,
      anchorId: parsed.data.anchorId,
      actor: auth.actor,
    });

    return apiJson({ anchor_id: removed.id, deleted: true }, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
