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
export async function handleMcpHttpRequest(options: {
  client: ClewwikiRestClient;
  request: Request;
}): Promise<Response> {
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
