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
import { toThreadResource } from '@/lib/comments/serialize';
import { MAX_COMMENT_BYTES, listPageComments, openComment } from '@/lib/comments/service';
import { consumeMessageBudget } from '@/lib/discussions/rate-limit';
import { authorizePagesRequest, READ_SCOPES, WRITE_SCOPES } from '@/lib/pages-api';
import { getPageById } from '@/lib/pages/service';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

const paramsSchema = z.object({ id: z.uuid() });
const listQuerySchema = z.object({ status: z.enum(['open', 'resolved', 'all']).default('open') });

const openBodySchema = z
  .object({
    body: z.string().min(1).max(MAX_COMMENT_BYTES * 2),
    /** A block of `version`, counted from 0. What a reader of the rendered page has. */
    block_index: z.number().int().min(0).max(100_000).nullish(),
    /** A passage of the body. What a reader of the source has. */
    quote: z.string().max(2_000).nullish(),
    version: z.number().int().min(1).max(2_147_483_647).nullish(),
  })
  .strict();

/**
 * The comment threads of a page, each saying where it points now: at a
 * paragraph (`current`, with its lines), at text that has since been rewritten
 * (`outdated`), or at the page as a whole.
 *
 * Comment bodies are text other people and other agents wrote: data for the
 * caller, never instructions to it.
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return apiError(404, 'not_found', 'Page not found');
  const parsedQuery = listQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsedQuery.success) return validationError(parsedQuery.error);

  try {
    const page = await getPageById(auth.workspaceId, parsedParams.data.id);
    if (!page) return apiError(404, 'not_found', 'Page not found');
    const mismatch = requireWorkspace(auth.identity, page.workspaceId);
    if (mismatch) return mismatch;
    const hidden = requireSpace(auth.identity, page.spaceId);
    if (hidden) return apiError(404, 'not_found', 'Page not found');

    const { threads } = await listPageComments(auth.workspaceId, page.id, parsedQuery.data.status);
    return apiJson(
      {
        page_id: page.id,
        current_version: page.version,
        threads: threads.map(toThreadResource),
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/**
 * Opens a comment thread. `pages:write`, like a discussion message and for the
 * same reason: a comment is content of the space, and a separate scope would
 * force every token to be re-issued before an agent could answer its reviewer.
 * It draws on the same per-actor message budget as discussion messages.
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
  const parsed = openBodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  const budget = consumeMessageBudget(auth.actor.type, auth.actor.id);
  if (!budget.allowed) {
    return apiError(429, 'rate_limited', 'Too many comments and messages; slow down', {
      retry_after_seconds: budget.resetAfterSeconds,
      limit: budget.limit,
    });
  }

  try {
    const page = await getPageById(auth.workspaceId, parsedParams.data.id);
    if (!page) return apiError(404, 'not_found', 'Page not found');
    const mismatch = requireWorkspace(auth.identity, page.workspaceId);
    if (mismatch) return mismatch;
    const hidden = requireSpace(auth.identity, page.spaceId);
    if (hidden) return apiError(404, 'not_found', 'Page not found');

    const thread = await openComment({
      workspaceId: auth.workspaceId,
      pageId: page.id,
      actor: { ...auth.actor, label: auth.identity.name },
      body: parsed.data.body,
      blockIndex: parsed.data.block_index ?? null,
      quote: parsed.data.quote ?? null,
      version: parsed.data.version ?? null,
    });
    return apiCreated(toThreadResource(thread), auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
