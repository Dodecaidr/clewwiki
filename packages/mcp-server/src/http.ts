import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { ClewwikiRestClient } from './rest-client.ts';
import { createClewwikiMcpServer } from './server.ts';

/**
 * One streamable HTTP request, answered by a server instance that lives only
 * as long as the request does.
 *
 * Stateless on purpose. The HTTP transport is mounted inside the Next
 * application, where a handler is a function call rather than a connection: a
 * session map held in a module would be state that one replica has and the
 * next does not, which is worse than no sessions at all. The eleven tools are
 * request/response, so there is nothing a session would carry.
 *
 * This lives in the package rather than in the route handler so that the SDK
 * stays a dependency of one place, and so the transport can be exercised
 * without a Next server around it.
 */
/**
 * Most JSON-RPC messages one HTTP request may carry.
 *
 * The transport dispatches the messages of a batch concurrently, and each tool
 * call is at least one REST request with its own token lookup and audit row.
 * Unbounded, one POST of a few megabytes would fan out into tens of thousands
 * of concurrent calls against the instance — past the per-token rate limit,
 * which is only consulted once per HTTP request here. Ten is more than any
 * client batches in practice.
 */
export const MAX_BATCH_MESSAGES = 10;

function batchTooLarge(): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      error: { code: -32600, message: `A batch may carry at most ${MAX_BATCH_MESSAGES} messages` },
      id: null,
    },
    { status: 400, headers: { 'Cache-Control': 'no-store' } },
  );
}

/** The number of messages in a JSON-RPC body, or null when it is not a batch. */
async function batchSize(request: Request): Promise<number | null> {
  const text = await request.clone().text();
  if (!text.trimStart().startsWith('[')) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    // Not JSON at all: the transport answers that with its own parse error.
    return null;
  }
}

export async function handleMcpHttpRequest(options: {
  client: ClewwikiRestClient;
  request: Request;
}): Promise<Response> {
  if (options.request.method === 'POST') {
    const size = await batchSize(options.request);
    if (size !== null && size > MAX_BATCH_MESSAGES) return batchTooLarge();
  }

  const server = createClewwikiMcpServer({ client: options.client });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    const result = await transport.handleRequest(options.request);

    // The body is buffered rather than passed on as a stream, because the
    // server is closed on the way out of this function and a half-read stream
    // would close with it. `enableJsonResponse` means every answer is either a
    // complete JSON document or an empty 202, so there is nothing to stream.
    const body = await result.text();
    return new Response(body === '' ? null : body, {
      status: result.status,
      headers: result.headers,
    });
  } finally {
    await server.close().catch(() => undefined);
  }
}
