import { z } from 'zod';

import { apiError, apiJson, readJsonBody, serviceErrorResponse, validationError } from '@/lib/api-response';
import { requireSpace, requireWorkspace } from '@/lib/api-auth';
import type { ApiIdentity } from '@/lib/api-auth';
import {
  applyRoomAwareness,
  applyRoomUpdate,
  joinRoom,
  leaveRoom,
  resumeRoom,
  saveRoom,
} from '@/lib/collab/rooms';
import type { RoomEvent } from '@/lib/collab/rooms';
import { authorizePagesRequest, WRITE_SCOPES } from '@/lib/pages-api';
import { getPageById } from '@/lib/pages/service';
import { toPageResource } from '@/lib/pages/serialize';
import { getSpaceById } from '@/lib/spaces/service';

export const dynamic = 'force-dynamic';
// A stream that stays open for as long as the editor does.
export const maxDuration = 3600;

type RouteContext = { params: Promise<{ id: string }> };

const paramsSchema = z.object({ id: z.uuid() });

/** How often a comment line is sent so that proxies keep an idle stream open. */
const HEARTBEAT_MS = 20_000;
/** Chunks a browser may fall behind by before its stream is closed for it to reconnect. */
const MAX_BACKLOG = 512;

const PEOPLE_ONLY =
  'Live editing sessions are for signed-in people. An agent writes a page under its own claim, and is told when a session holds the page.';

const joinQuerySchema = z.object({
  client: z.uuid(),
  // A Yjs client id is a random 32-bit unsigned integer.
  y: z.coerce.number().int().min(0).max(4_294_967_295),
});

const b64 = z.string().min(1).max(1_500_000);

const messageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('update'), client: z.uuid(), update: b64 }).strict(),
  z.object({ kind: z.literal('seed'), client: z.uuid(), update: b64 }).strict(),
  z.object({ kind: z.literal('awareness'), client: z.uuid(), update: b64 }).strict(),
  z.object({ kind: z.literal('resume'), client: z.uuid() }).strict(),
  z
    .object({
      kind: z.literal('save'),
      client: z.uuid(),
      body: z.string().max(1_000_000),
      state_vector: z.string().min(1).max(100_000),
      title: z.string().trim().min(1).max(300).optional(),
      summary: z.string().max(2_000).nullish(),
    })
    .strict(),
]);

type Gate =
  | { ok: true; identity: Extract<ApiIdentity, { type: 'user' }>; workspaceId: string; pageId: string }
  | { ok: false; response: Response };

/**
 * Who may be in a room: a signed-in person who can see the page's space. The
 * write scope is asked for because joining takes a claim; a bearer token is
 * refused whatever it carries.
 */
async function gate(request: Request, context: RouteContext): Promise<Gate> {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return { ok: false, response: auth.response };
  if (auth.identity.type !== 'user') {
    return { ok: false, response: apiError(403, 'forbidden', PEOPLE_ONLY) };
  }
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return { ok: false, response: apiError(404, 'not_found', 'Page not found') };

  const page = await getPageById(auth.workspaceId, params.data.id);
  if (!page) return { ok: false, response: apiError(404, 'not_found', 'Page not found') };
  const mismatch = requireWorkspace(auth.identity, page.workspaceId);
  if (mismatch) return { ok: false, response: mismatch };
  const hidden = requireSpace(auth.identity, page.spaceId);
  if (hidden) return { ok: false, response: apiError(404, 'not_found', 'Page not found') };

  return { ok: true, identity: auth.identity, workspaceId: auth.workspaceId, pageId: page.id };
}

/**
 * Joins the page's live editing session and streams what happens in it, as
 * server-sent events: the document so far, other people's edits and cursors,
 * who is present, saves, and whether the session holds the page.
 *
 * Server-sent events rather than a WebSocket on purpose. They are an ordinary
 * HTTP response, so a self-hosted instance needs no second process, no second
 * port and no change to its reverse proxy beyond not buffering this one path —
 * which the `X-Accel-Buffering` header asks for. What a browser sends goes the
 * other way as ordinary `POST`s to this same path.
 */
export async function GET(request: Request, context: RouteContext) {
  const allowed = await gate(request, context);
  if (!allowed.ok) return allowed.response;

  const query = joinQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return validationError(query.error);

  const encoder = new TextEncoder();
  const pending: Uint8Array[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    void leaveRoom(allowed.pageId, query.data.client, send).catch((error: unknown) =>
      console.error('[collab] leave failed', error),
    );
    try {
      controller?.close();
    } catch {
      // Already closed by the other side.
    }
  };

  const write = (chunk: Uint8Array): void => {
    if (closed) return;
    if (!controller) {
      pending.push(chunk);
      return;
    }
    // A browser that cannot keep up is disconnected rather than buffered for
    // without bound; it reconnects and is sent the document as it then stands.
    if ((controller.desiredSize ?? 0) < -MAX_BACKLOG) {
      close();
      return;
    }
    try {
      controller.enqueue(chunk);
    } catch {
      close();
    }
  };

  const send = (event: RoomEvent): void =>
    write(encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`));

  try {
    // Joined before the response starts, so a refusal is a status code and not
    // an event on a stream that opened successfully.
    await joinRoom({
      workspaceId: allowed.workspaceId,
      pageId: allowed.pageId,
      clientId: query.data.client,
      yClientId: query.data.y,
      user: { id: allowed.identity.userId, name: allowed.identity.name },
      send,
      close: () => close(),
    });
  } catch (error) {
    return serviceErrorResponse(error);
  }

  request.signal.addEventListener('abort', close);

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      for (const chunk of pending.splice(0)) streamController.enqueue(chunk);
      heartbeat = setInterval(() => write(encoder.encode(': keep-alive\n\n')), HEARTBEAT_MS);
      heartbeat.unref?.();
    },
    cancel() {
      close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/**
 * What a browser in the session sends: a document update, the update that
 * builds the document from the page (`seed`), its cursor (`awareness`), a
 * request to take the page back after a pause (`resume`), or a save.
 */
export async function POST(request: Request, context: RouteContext) {
  const allowed = await gate(request, context);
  if (!allowed.ok) return allowed.response;

  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch {
    return apiError(400, 'validation', 'Request body is not valid JSON');
  }
  const parsed = messageSchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);
  const message = parsed.data;
  const userId = allowed.identity.userId;

  try {
    switch (message.kind) {
      case 'update':
      case 'seed':
        await applyRoomUpdate({
          pageId: allowed.pageId,
          clientId: message.client,
          userId,
          update: message.update,
          seed: message.kind === 'seed',
        });
        return apiJson({ ok: true });
      case 'awareness':
        applyRoomAwareness({
          pageId: allowed.pageId,
          clientId: message.client,
          userId,
          update: message.update,
        });
        return apiJson({ ok: true });
      case 'resume': {
        const live = await resumeRoom(allowed.pageId, message.client, userId);
        return apiJson({ status: live ? 'live' : 'paused' });
      }
      case 'save': {
        const result = await saveRoom({
          workspaceId: allowed.workspaceId,
          pageId: allowed.pageId,
          clientId: message.client,
          user: { id: userId, name: allowed.identity.name },
          body: message.body,
          stateVector: message.state_vector,
          title: message.title,
          summary: message.summary,
        });
        const space = await getSpaceById(allowed.workspaceId, result.page.spaceId);
        if (!space) return apiError(404, 'not_found', 'Page not found');
        return apiJson({
          written: result.written,
          ...toPageResource(result.page, space, { linkedPage: null, claim: null }),
        });
      }
    }
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
