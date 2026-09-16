import { z } from 'zod';

import {
  apiCreated,
  apiError,
  apiJson,
  readJsonBody,
  serviceErrorResponse,
  validationError,
} from '@/lib/api-response';
import { requireWorkspace } from '@/lib/api-auth';
import { getActiveNotesForPage, getClaimById, postNote, MAX_NOTE_LENGTH } from '@/lib/claims/service';
import { toClaimNoteResource } from '@/lib/claims/serialize';
import { authorizePagesRequest, claimActorOf, READ_SCOPES, WRITE_SCOPES } from '@/lib/pages-api';
import { getPageById } from '@/lib/pages/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

const noteBodySchema = z.object({
  claim_id: z.uuid(),
  text: z.string().trim().min(1).max(MAX_NOTE_LENGTH),
});

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Leaves a short-lived note on a claim the caller holds.
 *
 * A note says what its author is doing while the edit is in flight — "rewriting
 * the auth section, leave Overview alone". It is not a revision: it never
 * reaches the page's history, and it is deleted when the claim ends.
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

  const parsed = noteBodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  try {
    const page = await getPageById(auth.workspaceId, parsedParams.data.id);
    if (!page) return apiError(404, 'not_found', 'Page not found');

    const mismatch = requireWorkspace(auth.identity, page.workspaceId);
    if (mismatch) return mismatch;

    const claim = await getClaimById(auth.workspaceId, parsed.data.claim_id);
    if (!claim) return apiError(404, 'not_found', 'Claim not found');
    if (claim.pageId !== page.id) {
      return apiError(409, 'conflict', 'Claim does not cover this page');
    }

    const note = await postNote({
      workspaceId: auth.workspaceId,
      claimId: claim.id,
      text: parsed.data.text,
      actor: claimActorOf(auth.identity),
    });

    return apiCreated(toClaimNoteResource(note), auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/**
 * The notes currently attached to this page's live claims.
 *
 * Only active ones: a note whose claim has lapsed is filtered by the query
 * rather than trusted to the sweep, so it stops being readable the moment the
 * lease it belonged to does.
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return apiError(404, 'not_found', 'Page not found');

  try {
    const page = await getPageById(auth.workspaceId, parsed.data.id);
    if (!page) return apiError(404, 'not_found', 'Page not found');

    const mismatch = requireWorkspace(auth.identity, page.workspaceId);
    if (mismatch) return mismatch;

    const notes = await getActiveNotesForPage(auth.workspaceId, page.id);
    return apiJson({ notes: notes.map(toClaimNoteResource) }, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
