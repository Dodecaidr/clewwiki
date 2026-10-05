import { z } from 'zod';

import { apiCreated, apiError, readJsonBody, serviceErrorResponse, validationError } from '@/lib/api-response';
import { streamResource } from '@/lib/development/api';
import { STREAM_STATES, createStream } from '@/lib/development/service';
import { spaceFromRoute } from '@/lib/development/space-route';
import { actorOf, authorizePagesRequest, WRITE_SCOPES } from '@/lib/pages-api';

export const dynamic = 'force-dynamic';

const streamBodySchema = z
  .object({
    title: z.string().min(1).max(240),
    branch: z.string().max(200).nullish(),
    state: z.enum(STREAM_STATES).optional(),
    goal: z.string().max(40_000).optional(),
    issue_keys: z.array(z.string().max(40)).max(50).optional(),
    release_id: z.uuid().nullish(),
    docs_page_id: z.uuid().nullish(),
  })
  .strict();

/** Starts a line of development by hand — one without a branch yet, or before the next sync. */
export async function POST(request: Request, context: { params: Promise<{ key: string }> }) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;
  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch {
    return apiError(400, 'validation', 'Request body is not valid JSON');
  }
  const parsed = streamBodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);
  try {
    const route = await spaceFromRoute(auth.identity, (await context.params).key);
    if (!route.ok) return route.response;
    const stream = await createStream(auth.workspaceId, route.space.id, actorOf(auth.identity), {
      title: parsed.data.title,
      ref: parsed.data.branch ?? null,
      state: parsed.data.state,
      goal: parsed.data.goal,
      issueKeys: parsed.data.issue_keys,
      releaseId: parsed.data.release_id ?? null,
      docsPageId: parsed.data.docs_page_id ?? null,
    });
    return apiCreated({ stream: streamResource(stream, auth.identity.workspace) }, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
