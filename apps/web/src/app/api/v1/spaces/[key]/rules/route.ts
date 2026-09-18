import { apiError, apiJson, serviceErrorResponse } from '@/lib/api-response';
import { requireWorkspace } from '@/lib/api-auth';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';
import { getPageById } from '@/lib/pages/service';
import { resolveSpaceParam } from '@/lib/spaces/access';
import { spaceKeyParamSchema } from '@/lib/spaces/keys';

export const dynamic = 'force-dynamic';

/**
 * The working rules of one space, in one call.
 *
 * The point of the endpoint is that an agent starting on a project does not
 * have to hope somebody pasted the conventions into its prompt: it asks the
 * space for them. The rules are an ordinary page, so what comes back is that
 * page's identity and body — nothing is summarised or rewritten on the way out.
 *
 * `pages:read`, and space-restricted like everything else: a space the caller
 * cannot see is `404`, and so is a space with no rules page designated, because
 * "there are no rules here" and "you may not see them" must read the same to a
 * caller who is not allowed to tell them apart.
 */
export async function GET(request: Request, context: { params: Promise<{ key: string }> }) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const key = spaceKeyParamSchema.safeParse((await context.params).key);
  if (!key.success) return apiError(404, 'not_found', 'Space not found');

  try {
    const resolved = await resolveSpaceParam(auth.identity, key.data);
    if (!resolved.ok) return resolved.response;
    const mismatch = requireWorkspace(auth.identity, resolved.space.workspaceId);
    if (mismatch) return mismatch;

    const rulesPageId = resolved.space.rulesPageId;
    if (!rulesPageId) {
      return apiError(404, 'not_found', 'This space has no rules page', { space: resolved.space.key });
    }

    // A page deleted after it was designated is treated as no rules page; the
    // column is cleared by the foreign key only when the row goes away for good.
    const page = await getPageById(auth.workspaceId, rulesPageId);
    if (!page || page.spaceId !== resolved.space.id) {
      return apiError(404, 'not_found', 'This space has no rules page', { space: resolved.space.key });
    }

    return apiJson(
      {
        space: { key: resolved.space.key, name: resolved.space.name },
        page_id: page.id,
        path: page.path,
        title: page.title,
        content_hash: page.contentHash,
        body: page.body,
        updated_at: page.updatedAt.toISOString(),
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
