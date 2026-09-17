import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleMcpHttpRequest } from '../src/http.ts';
import { ClewwikiRestClient } from '../src/rest-client.ts';
import { startFakeRest } from './helpers/fake-rest.ts';
import type { FakeRest } from './helpers/fake-rest.ts';

const TOKEN = 'http-transport-token';

function post(body: unknown): Request {
  return new Request('http://wiki.example.com/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
}

describe('streamable HTTP transport, stateless', () => {
  let rest: FakeRest;
  let client: ClewwikiRestClient;

  beforeAll(async () => {
    rest = await startFakeRest({ token: TOKEN });
    client = new ClewwikiRestClient({ baseUrl: rest.url, token: TOKEN });
  });

  afterAll(async () => {
    await rest.close();
  });

  async function rpc(method: string, params: Record<string, unknown>, id = 1) {
    const response = await handleMcpHttpRequest({ client, request: post({ jsonrpc: '2.0', id, method, params }) });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  }

  it('answers initialize with the server identity', async () => {
    const { status, body } = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'http-test', version: '0.0.0' },
    });
    expect(status).toBe(200);
    expect(body.result.serverInfo.name).toBe('clewwiki');
  });

  it('runs a tool call in a fresh server per request and returns the REST result', async () => {
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'http-test', version: '0.0.0' },
    });
    const { status, body } = await rpc('tools/call', {
      name: 'wiki.get_page',
      arguments: { page_id: rest.page.page_id },
    }, 2);
    expect(status).toBe(200);
    expect(body.result.isError).not.toBe(true);
    expect(body.result.structuredContent.page_id).toBe(rest.page.page_id);
  });
});
