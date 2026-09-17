import { ClewwikiRestClient, handleMcpHttpRequest } from '@clewwiki/mcp-server';

import { extractBearerToken } from '@/lib/agent-token-crypto';
import { authenticateRequest } from '@/lib/api-auth';
import { getMcpAllowedOrigins, getMcpInternalBaseUrl, isMcpHttpEnabled } from '@/lib/env';
import { corsHeaders, decideOrigin } from '@/lib/mcp/origin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The streamable HTTP MCP transport, for agents that do not run on the
 * developer's machine — CI, a remote runner, a hosted assistant.
 *
 * Three things are true of every request that gets past this file:
 *
 * 1. The endpoint is mounted only when the operator set `MCP_HTTP_ENABLED`.
 *    Otherwise it is a 404, because an endpoint nobody turned on should not
 *    confirm that it could be.
 * 2. It carries an agent token. There is no anonymous MCP over HTTP and no
 *    session-cookie path into it: a browser that happens to be signed in must
 *    not be a way to drive an agent API.
 * 3. It came from something that is not a browser, or from a browser origin
 *    the operator listed. The allowlist is empty by default.
 *
 * The transport runs stateless — a server instance per request, no session
 * store — because a Next route handler is not a long-lived connection and a
 * session map in a module would be per-replica state pretending to be shared.
 * The thirteen tools are request/response, so nothing is lost: there are no
 * server-initiated notifications to keep a stream open for, and `GET` and
 * `DELETE` say so with 405 rather than pretending to hold a session.
 *
 * TLS is the operator's, as everywhere else in this application: mount this
 * behind the same reverse proxy that terminates HTTPS for the web UI.
 */

const PROTOCOL_ERROR_HEADERS = { 'Cache-Control': 'no-store' } as const;

function jsonRpcError(status: number, code: number, message: string, extra: HeadersInit = {}): Response {
  return Response.json(
    { jsonrpc: '2.0', error: { code, message }, id: null },
    { status, headers: { ...PROTOCOL_ERROR_HEADERS, ...extra } },
  );
}

export async function POST(request: Request): Promise<Response> {
  if (!isMcpHttpEnabled()) return new Response(null, { status: 404 });

  const origin = decideOrigin(request.headers.get('origin'), getMcpAllowedOrigins());
  if (!origin.allowed) {
    return jsonRpcError(403, -32600, 'Origin is not allowed to reach this endpoint');
  }
  const cors = corsHeaders(origin.origin);

  // A bearer token, and only a bearer token. `authenticateRequest` would
  // otherwise fall back to the browser session, and this endpoint is not for
  // browsers.
  const bearer = extractBearerToken(request.headers.get('authorization'));
  if (bearer === null) {
    return jsonRpcError(401, -32001, 'An agent token is required', {
      'WWW-Authenticate': 'Bearer realm="clewwiki"',
      ...cors,
    });
  }

  // The existing resolver: expiry, revocation, workspace, per-token rate limit
  // and the audit row, exactly as for any other request. Its rejection
  // response is returned unchanged, so a revoked token gets the same answer
  // here as it does from the REST API.
  const auth = await authenticateRequest(request);
  if (!auth.ok) {
    for (const [key, value] of Object.entries(cors)) auth.response.headers.set(key, value);
    return auth.response;
  }
  if (auth.identity.type !== 'agent') {
    return jsonRpcError(403, -32001, 'This endpoint is for agent tokens only', cors);
  }

  try {
    const result = await handleMcpHttpRequest({
      request,
      client: new ClewwikiRestClient({ baseUrl: getMcpInternalBaseUrl(), token: bearer }),
    });

    const headers = new Headers(result.headers);
    for (const [key, value] of Object.entries({ ...cors, 'Cache-Control': 'no-store' })) {
      headers.set(key, value);
    }
    for (const [key, value] of Object.entries(auth.headers ?? {})) headers.set(key, value);

    return new Response(result.body, { status: result.status, headers });
  } catch (error) {
    console.error('[mcp] request failed', error);
    return jsonRpcError(500, -32603, 'The MCP request could not be completed', cors);
  }
}

/**
 * Preflight for an allowlisted browser origin. A browser that is not on the
 * list is refused here too, so it never gets as far as sending the token.
 */
export async function OPTIONS(request: Request): Promise<Response> {
  if (!isMcpHttpEnabled()) return new Response(null, { status: 404 });

  const origin = decideOrigin(request.headers.get('origin'), getMcpAllowedOrigins());
  if (!origin.allowed) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(origin.origin) });
}

/** No standalone stream and no session to delete: stateless, by design. */
export async function GET(): Promise<Response> {
  if (!isMcpHttpEnabled()) return new Response(null, { status: 404 });
  return jsonRpcError(405, -32000, 'This endpoint is stateless: use POST', { Allow: 'POST, OPTIONS' });
}

export async function DELETE(): Promise<Response> {
  if (!isMcpHttpEnabled()) return new Response(null, { status: 404 });
  return jsonRpcError(405, -32000, 'This endpoint is stateless: there is no session to end', {
    Allow: 'POST, OPTIONS',
  });
}
