import { z } from 'zod';

import {
  apiError,
  apiJson,
  readJsonBody,
  serviceErrorResponse,
  validationError,
} from '@/lib/api-response';
import { requireWorkspace } from '@/lib/api-auth';
import { confirmAnchor, getAnchorById } from '@/lib/anchors/service';
import { toAnchorResource } from '@/lib/anchors/serialize';
import { authorizePagesRequest, WRITE_SCOPES } from '@/lib/pages-api';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ anchorId: z.uuid() });
const bodySchema = z.object({ ref: z.string().trim().min(1).max(200).nullish() });

/**
 * Clears a flag after review: the reader has looked at the change and says the
 * documentation still describes the code.
 *
 * This is the only path that re-baselines an anchor's hashes, and it is
 * deliberately a separate, audited act. Nothing clears itself — a badge that
 * disappears without anyone deciding it should is a badge whose silence means
 * nothing.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ anchorId: string }> },
) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return apiError(404, 'not_found', 'Anchor not found');

  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch {
    return apiError(400, 'validation', 'Request body is not valid JSON');
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  try {
    const existing = await getAnchorById(auth.workspaceId, parsedParams.data.anchorId);
    if (!existing) return apiError(404, 'not_found', 'Anchor not found');

    const mismatch = requireWorkspace(auth.identity, existing.workspaceId);
    if (mismatch) return mismatch;

    const anchor = await confirmAnchor({
      workspaceId: auth.workspaceId,
      anchorId: parsedParams.data.anchorId,
      actor: auth.actor,
      workspaceSettings: auth.identity.workspace.settings,
      ref: parsed.data.ref,
    });

    return apiJson(toAnchorResource(anchor), auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
