import { z } from 'zod';

import { apiError, apiJson, readJsonBody, serviceErrorResponse, validationError } from '@/lib/api-response';
import { requireWorkspace } from '@/lib/api-auth';
import { listAnchorsForPage } from '@/lib/anchors/service';
import { authorizePagesRequest, READ_SCOPES, WRITE_SCOPES } from '@/lib/pages-api';
import { getActiveClaimsForPage } from '@/lib/claims/service';
import { CONTENT_HASH_PATTERN } from '@/lib/pages/content';
import { deletePage, getPageById, updatePage } from '@/lib/pages/service';
import { toPageResource } from '@/lib/pages/serialize';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

const patchBodySchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    body: z.string().max(1_000_000).optional(),
    summary: z.string().max(2_000).nullish(),
    kind: z.enum(['technical', 'human']).optional(),
    parent_id: z.uuid().nullish(),
    path: z.string().min(1).max(512).optional(),
    // Both halves of the write protocol. `claim_id` is deliberately not
    // required by the schema: a write with no claim is a protocol violation
    // rather than a malformed request, and the service answers it with the
    // `conflict` the contract names, holder details included.
    claim_id: z.uuid().optional(),
    base_content_hash: z.string().regex(CONTENT_HASH_PATTERN),
  });

type RouteContext = { params: Promise<{ id: string }> };

/**
 * One page, with its body, its content hash and its linked counterpart.
 *
 * The hash is part of every read on purpose: it is what a later write echoes
 * back to prove it was built on the content that is actually stored.
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return apiError(404, 'not_found', 'Page not found');

  try {
    const page = await getPageById(auth.workspaceId, parsed.data.id);
    if (!page) return apiError(404, 'not_found', 'Page not found');

    // The row was already selected under the caller's workspace; asserting it
    // again here is the explicit check the handler owns, so a future change to
    // the query cannot widen what this endpoint answers with.
    const mismatch = requireWorkspace(auth.identity, page.workspaceId);
    if (mismatch) return mismatch;

    const [linked, activeClaims, pageAnchors] = await Promise.all([
      page.linkedPageId ? getPageById(auth.workspaceId, page.linkedPageId) : Promise.resolve(null),
      getActiveClaimsForPage(auth.workspaceId, page.id),
      // The state stored by the last check, not a fresh one: recomputing costs
      // a repository fetch, and a read of a page must not depend on the
      // network. `GET …/anchors/check` is where that is asked for explicitly.
      listAnchorsForPage(auth.workspaceId, page.id),
    ]);

    // A page-level claim outranks a section claim in this slot: it is the
    // stronger statement about who may write to the page right now.
    const claim =
      activeClaims.find((candidate) => candidate.sectionId === null) ?? activeClaims[0] ?? null;

    return apiJson(
      toPageResource(page, { linkedPage: linked, claim, anchors: pageAnchors }),
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/**
 * Updates a page: writes a revision, bumps the version, recomputes the hash.
 *
 * Since Phase 3 this needs a claim. `claim_id` must name a lease the caller
 * holds on this page (page-level, or a section of it), and `base_content_hash`
 * must still match what is stored — the lease says nobody else may write, the
 * hash proves nobody did.
 */
export async function PATCH(request: Request, context: RouteContext) {
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

  const parsed = patchBodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  try {
    const existing = await getPageById(auth.workspaceId, parsedParams.data.id);
    if (!existing) return apiError(404, 'not_found', 'Page not found');

    const mismatch = requireWorkspace(auth.identity, existing.workspaceId);
    if (mismatch) return mismatch;

    const page = await updatePage({
      workspaceId: auth.workspaceId,
      pageId: parsedParams.data.id,
      actor: auth.actor,
      title: parsed.data.title,
      body: parsed.data.body,
      summary: parsed.data.summary,
      kind: parsed.data.kind,
      parentId: parsed.data.parent_id,
      path: parsed.data.path,
      claimId: parsed.data.claim_id ?? '',
      baseContentHash: parsed.data.base_content_hash,
    });

    const linked = page.linkedPageId
      ? await getPageById(auth.workspaceId, page.linkedPageId)
      : null;

    return apiJson(toPageResource(page, { linkedPage: linked }), auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/**
 * Soft-deletes a page and everything below it. The rows stay so their history
 * stays; the path becomes available again.
 */
export async function DELETE(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return apiError(404, 'not_found', 'Page not found');

  try {
    const existing = await getPageById(auth.workspaceId, parsed.data.id);
    if (!existing) return apiError(404, 'not_found', 'Page not found');

    const mismatch = requireWorkspace(auth.identity, existing.workspaceId);
    if (mismatch) return mismatch;

    const result = await deletePage({
      workspaceId: auth.workspaceId,
      pageId: parsed.data.id,
      actor: auth.actor,
    });

    return apiJson(
      { page_id: parsed.data.id, deleted: true, pages_deleted: result.deleted },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
