import { z } from 'zod';

import { apiError, apiJson, readJsonBody, serviceErrorResponse, validationError } from '@/lib/api-response';
import { requireSpace, requireWorkspace } from '@/lib/api-auth';
import { authorizePagesRequest, WRITE_SCOPES } from '@/lib/pages-api';
import { getPageById, linkPages } from '@/lib/pages/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });
const bodySchema = z.object({ linked_page_id: z.uuid().nullable() });

/**
 * Pairs a technical page with its human counterpart, or breaks the pair when
 * `linked_page_id` is `null`.
 *
 * Both rows are written in one transaction, so the pair is either visible from
 * both sides or from neither. The two pages must be of different kinds — a
 * pair of two technical pages is not the relationship this models. Both pages
 * must be in the same space; a counterpart anywhere else is not found.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return apiError(404, 'not_found', 'Page not found');

  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch {
    return apiError(400, 'validation', 'Request body is not valid JSON');
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  try {
    const page = await getPageById(auth.workspaceId, parsedParams.data.id);
    if (!page) return apiError(404, 'not_found', 'Page not found');
    const mismatch = requireWorkspace(auth.identity, page.workspaceId);
    if (mismatch) return mismatch;
    const hidden = requireSpace(auth.identity, page.spaceId);
    if (hidden) return apiError(404, 'not_found', 'Page not found');

    // The service looks the counterpart up inside this page's space, so a
    // token that can see this page cannot reach a page in a space it cannot.
    const result = await linkPages({
      workspaceId: auth.workspaceId,
      pageId: parsedParams.data.id,
      linkedPageId: parsed.data.linked_page_id,
      actor: auth.actor,
    });

    return apiJson(
      { page_id: result.pageId, linked_page_id: result.linkedPageId },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
