import { z } from 'zod';

import { apiCreated, apiError, readJsonBody, serviceErrorResponse, validationError } from '@/lib/api-response';
import { releaseResource } from '@/lib/development/api';
import { createRelease } from '@/lib/development/service';
import { spaceFromRoute } from '@/lib/development/space-route';
import { actorOf, authorizePagesRequest, WRITE_SCOPES } from '@/lib/pages-api';

export const dynamic = 'force-dynamic';

const bodySchema = z
  .object({ name: z.string().min(1).max(80), due_on: z.string().max(20).nullish(), notes: z.string().max(10_000).optional() })
  .strict();

/** Plans a release; streams are then filed under it. */
export async function POST(request: Request, context: { params: Promise<{ key: string }> }) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;
  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch {
    return apiError(400, 'validation', 'Request body is not valid JSON');
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);
  try {
    const route = await spaceFromRoute(auth.identity, (await context.params).key);
    if (!route.ok) return route.response;
    const release = await createRelease(auth.workspaceId, route.space.id, actorOf(auth.identity), {
      name: parsed.data.name,
      dueOn: parsed.data.due_on ?? null,
      notes: parsed.data.notes,
    });
    return apiCreated({ release: releaseResource(release) }, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
