import { z } from 'zod';

import {
  apiCreated,
  apiError,
  apiJson,
  readJsonBody,
  serviceErrorResponse,
  validationError,
} from '@/lib/api-response';
import { requireSpace, requireWorkspace } from '@/lib/api-auth';
import { acquireClaim, getActiveClaimsForPage } from '@/lib/claims/service';
import { toClaimResource } from '@/lib/claims/serialize';
import { MAX_CLAIM_TTL_SECONDS, MIN_CLAIM_TTL_SECONDS } from '@/lib/claims/ttl';
import { authorizePagesRequest, claimActorOf, READ_SCOPES, WRITE_SCOPES } from '@/lib/pages-api';
import { getPageById } from '@/lib/pages/service';
import { getSpaceById } from '@/lib/spaces/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

const claimBodySchema = z.object({
  section_id: z.string().trim().min(1).max(200).nullish(),
  ttl_seconds: z
    .number()
    .int()
    .min(MIN_CLAIM_TTL_SECONDS)
    .max(MAX_CLAIM_TTL_SECONDS)
    .optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Takes a claim on a page, or on a named section of one.
 *
 * `201` when a new lease was granted, `200` when the caller already held this
 * exact target and it was extended instead — re-claiming your own lease is a
 * heartbeat, not a conflict. `409` carries who holds it, since when and until
 * when, so the caller can wait, ask, or claim a different section.
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

  const parsed = claimBodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  try {
    const page = await getPageById(auth.workspaceId, parsedParams.data.id);
    if (!page) return apiError(404, 'not_found', 'Page not found');

    const mismatch = requireWorkspace(auth.identity, page.workspaceId);
    if (mismatch) return mismatch;
    const hidden = requireSpace(auth.identity, page.spaceId);
    if (hidden) return apiError(404, 'not_found', 'Page not found');

    const result = await acquireClaim({
      workspaceId: auth.workspaceId,
      pageId: page.id,
      sectionId: parsed.data.section_id ?? null,
      actor: claimActorOf(auth.identity),
      ttlSeconds: parsed.data.ttl_seconds,
      settings: auth.identity.workspace.settings,
    });

    const space = await getSpaceById(auth.workspaceId, page.spaceId);
    const body = toClaimResource(result.claim, {
      space: space ?? undefined,
      path: page.path,
      title: page.title,
    });
    return result.created ? apiCreated(body, auth.headers) : apiJson(body, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/** The live claims on one page: the page-level one and any section leases. */
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
    const hidden = requireSpace(auth.identity, page.spaceId);
    if (hidden) return apiError(404, 'not_found', 'Page not found');

    const [active, space] = await Promise.all([
      getActiveClaimsForPage(auth.workspaceId, page.id),
      getSpaceById(auth.workspaceId, page.spaceId),
    ]);
    return apiJson(
      {
        claims: active.map((claim) =>
          toClaimResource(claim, { space: space ?? undefined, path: page.path, title: page.title }),
        ),
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
