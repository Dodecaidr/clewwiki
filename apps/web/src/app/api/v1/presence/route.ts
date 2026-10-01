import { z } from 'zod';

import { apiError, apiJson, readJsonBody, serviceErrorResponse, validationError } from '@/lib/api-response';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';
import { getLivePresence, recordHeartbeat } from '@/lib/presence/live';
import type { LivePage } from '@/lib/presence/live';
import { findPage } from '@/lib/spaces/visibility';

export const dynamic = 'force-dynamic';

/**
 * Live presence: who has the wiki open and where, people and agents alike.
 * Claims say who is *changing* a page; this says who is *there*.
 */

const pageResource = (page: LivePage | null) =>
  page ? { page_id: page.id, title: page.title, space: page.spaceKey } : null;

export async function GET(request: Request) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;
  try {
    const live = await getLivePresence({ workspaceId: auth.workspaceId, spaceIds: auth.identity.spaceIds });
    // `?space=KEY` keeps those whose page is in that space.
    const space = new URL(request.url).searchParams.get('space')?.trim().toUpperCase() || null;
    const inScope = (page: LivePage | null) => space === null || page?.spaceKey === space;
    return apiJson(
      {
        people: live.people.filter((person) => inScope(person.page)).map((person) => ({
          name: person.name,
          mode: person.mode,
          automated_browser: person.automated,
          seen_at: person.seenAt.toISOString(),
          page: pageResource(person.page),
        })),
        agents: live.agents.filter((agent) => inScope(agent.page)).map((agent) => ({
          name: agent.name,
          last_seen: agent.lastSeen.toISOString(),
          requests: agent.requests,
          page: pageResource(agent.page),
        })),
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

const heartbeatSchema = z
  .object({
    page_id: z.uuid().nullable().optional(),
    mode: z.enum(['viewing', 'editing']).default('viewing'),
    automated: z.boolean().default(false),
  })
  .strict();

/** A person's open tab saying where it is. Agents are seen through their requests instead. */
export async function POST(request: Request) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;
  if (auth.identity.type !== 'user') {
    return apiError(403, 'forbidden', 'Heartbeats come from a person’s browser; agents are seen through their requests');
  }
  try {
    const body = heartbeatSchema.safeParse(await readJsonBody(request));
    if (!body.success) return validationError(body.error);
    // A page the person cannot see is recorded as nowhere in particular.
    const page = body.data.page_id ? await findPage(auth.identity, body.data.page_id) : null;
    await recordHeartbeat({
      workspaceId: auth.workspaceId,
      userId: auth.identity.userId,
      pageId: page?.id ?? null,
      mode: page ? body.data.mode : 'viewing',
      automated: body.data.automated,
    });
    return new Response(null, { status: 204, headers: auth.headers });
  } catch (error) {
    if (error instanceof SyntaxError) return apiError(400, 'validation', error.message);
    return serviceErrorResponse(error);
  }
}
