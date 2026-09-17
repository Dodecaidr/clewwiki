import { z } from 'zod';

import { apiError, apiJson, readJsonBody, serviceErrorResponse, validationError } from '@/lib/api-response';
import { requireSpace, requireWorkspace } from '@/lib/api-auth';
import { checkPageAnchors, getFallbackShare, listAnchorsForPage } from '@/lib/anchors/service';
import { toAnchorResource, toFallbackShareResource } from '@/lib/anchors/serialize';
import { authorizePagesRequest, READ_SCOPES, WRITE_SCOPES } from '@/lib/pages-api';
import { getPageById } from '@/lib/pages/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });
const refSchema = z.object({ ref: z.string().trim().min(1).max(200).optional() });

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The anchors' states as the last check left them. `pages:read`.
 *
 * Reading costs nothing and changes nothing: no fetch, no parse, no write. The
 * response has the same shape as a recompute, with `recomputed: false`, and
 * `checked_at` / `ref` are those of the most recent check of any anchor on the
 * page (null when none has been checked yet).
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return apiError(404, 'not_found', 'Page not found');

  try {
    const page = await getPageById(auth.workspaceId, parsedParams.data.id);
    if (!page) return apiError(404, 'not_found', 'Page not found');

    const mismatch = requireWorkspace(auth.identity, page.workspaceId);
    if (mismatch) return mismatch;
    const hidden = requireSpace(auth.identity, page.spaceId);
    if (hidden) return apiError(404, 'not_found', 'Page not found');

    const [stored, fallbackShare] = await Promise.all([
      listAnchorsForPage(auth.workspaceId, page.id),
      getFallbackShare(auth.workspaceId, page.spaceId),
    ]);
    const latest = stored.reduce<(typeof stored)[number] | null>(
      (best, anchor) =>
        anchor.lastCheckedAt !== null &&
        (best?.lastCheckedAt == null || anchor.lastCheckedAt > best.lastCheckedAt)
          ? anchor
          : best,
      null,
    );

    return apiJson(
      {
        page_id: page.id,
        recomputed: false,
        checked_at: latest?.lastCheckedAt?.toISOString() ?? null,
        ref: latest?.lastCheckedRef ?? null,
        commit: null,
        anchors: stored.map(toAnchorResource),
        fallback_share: toFallbackShareResource(fallbackShare),
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/**
 * Recomputes a page's anchors against the current state of the repository.
 *
 * `pages:write`: a recompute fetches from the repository, parses source and
 * writes the new states back onto the anchor rows, so it is a state change
 * rather than a question. Nothing on the page itself is touched, and nothing
 * is re-anchored automatically.
 *
 * The work is bounded by a read budget (files, bytes, time). When it runs out
 * the answer says so — `complete: false`, `budget.limit`, and the anchors that
 * could not be placed in `unchecked_anchor_ids`, whose stored state is left as
 * it was.
 *
 * `fallback_share` rides along on purpose. It is the space-wide share of
 * anchors sitting on the line-range path, and it is the number that says when
 * these states are about to stop being worth believing.
 */
export async function POST(request: Request, context: RouteContext) {
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
  // `ref` in the body, or in the query string for a caller that sends none.
  const queryRef = new URL(request.url).searchParams.get('ref') ?? undefined;
  const parsedBody = refSchema.safeParse({
    ref: queryRef,
    ...(typeof raw === 'object' && raw !== null ? raw : {}),
  });
  if (!parsedBody.success) return validationError(parsedBody.error);

  try {
    const page = await getPageById(auth.workspaceId, parsedParams.data.id);
    if (!page) return apiError(404, 'not_found', 'Page not found');

    const mismatch = requireWorkspace(auth.identity, page.workspaceId);
    if (mismatch) return mismatch;
    const hidden = requireSpace(auth.identity, page.spaceId);
    if (hidden) return apiError(404, 'not_found', 'Page not found');

    const result = await checkPageAnchors({
      workspaceId: auth.workspaceId,
      pageId: page.id,
      actor: auth.actor,
      ref: parsedBody.data.ref,
    });

    return apiJson(
      {
        page_id: page.id,
        recomputed: true,
        checked_at: result.checkedAt.toISOString(),
        ref: result.ref,
        commit: result.commit,
        complete: result.complete,
        unchecked_anchor_ids: result.uncheckedAnchorIds,
        budget: {
          files_read: result.budget.filesRead,
          bytes_read: result.budget.bytesRead,
          elapsed_ms: result.budget.elapsedMs,
          limit: result.budget.limit,
        },
        anchors: result.anchors.map(toAnchorResource),
        fallback_share: toFallbackShareResource(result.fallbackShare),
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
