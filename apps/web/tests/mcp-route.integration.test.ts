import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';

const probe = await prepareTestDatabase();

process.env.DATABASE_URL = databaseUrl || 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
process.env.AGENT_TOKEN_RATE_LIMIT_MAX ??= '1000';

type Handler = (request: Request) => Promise<Response>;

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'route-test', version: '0.0.0' },
  },
};

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3000/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function loadRoute(): Promise<{ POST: Handler; GET: () => Promise<Response> }> {
  return (await import('@/app/mcp/route')) as unknown as { POST: Handler; GET: () => Promise<Response> };
}

describe('/mcp before any database is involved', () => {
  afterEach(() => {
    delete process.env.MCP_HTTP_ENABLED;
    delete process.env.MCP_HTTP_ALLOWED_ORIGINS;
  });

  it('is a 404 while the operator has not enabled it', async () => {
    const { POST } = await loadRoute();
    const response = await POST(mcpRequest(INITIALIZE));
    expect(response.status).toBe(404);
  });

  it('rejects an unauthenticated request with 401 and a bearer challenge', async () => {
    process.env.MCP_HTTP_ENABLED = 'true';
    const { POST } = await loadRoute();
    const response = await POST(mcpRequest(INITIALIZE));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('does not accept a browser session cookie in place of a token', async () => {
    process.env.MCP_HTTP_ENABLED = 'true';
    const { POST } = await loadRoute();
    const response = await POST(
      mcpRequest(INITIALIZE, { cookie: 'better-auth.session_token=anything' }),
    );
    expect(response.status).toBe(401);
  });

  it('refuses a browser origin that is not on the allowlist before looking at the token', async () => {
    process.env.MCP_HTTP_ENABLED = 'true';
    const { POST } = await loadRoute();
    const response = await POST(
      mcpRequest(INITIALIZE, { origin: 'https://evil.example', authorization: 'Bearer cww_x.y' }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers GET with 405, because the endpoint keeps no session stream', async () => {
    process.env.MCP_HTTP_ENABLED = 'true';
    const { GET } = await loadRoute();
    const response = await GET();
    expect(response.status).toBe(405);
  });
});

describe.skipIf(!probe.reachable)('/mcp with a real agent token', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  const suiteTag = `mcp-${randomUUID().slice(0, 8)}`;
  let workspaceId: string;
  let token: string;
  let revokedToken: string;

  async function seed(name: string, revokedAt: Date | null): Promise<string> {
    const { generateAgentToken } = await import('@/lib/agent-token-crypto');
    const generated = generateAgentToken();
    await db.insert(schema.agentTokens).values({
      workspaceId,
      name,
      prefix: generated.prefix,
      tokenHash: generated.tokenHash,
      scopes: ['pages:read'],
      revokedAt,
    });
    return generated.token;
  }

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    db = schema.getDatabase();
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `MCP ${suiteTag}`, slug: suiteTag })
      .returning({ id: schema.workspaces.id });
    workspaceId = workspace!.id;
    token = await seed('mcp-agent', null);
    revokedToken = await seed('mcp-revoked', new Date(Date.now() - 60_000));
  });

  afterEach(() => {
    delete process.env.MCP_HTTP_ENABLED;
  });

  afterAll(async () => {
    if (!probe.reachable || !schema) return;
    const { eq } = await import('drizzle-orm');
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await schema.getDatabaseHandle().sql.end({ timeout: 5 });
  });

  it('initialises and lists the eleven tools for a valid token', async () => {
    process.env.MCP_HTTP_ENABLED = 'true';
    const { POST } = await loadRoute();
    const auth = { authorization: `Bearer ${token}` };

    const initialized = await POST(mcpRequest(INITIALIZE, auth));
    expect(initialized.status).toBe(200);

    const listed = await POST(mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, auth));
    expect(listed.status).toBe(200);
    const payload = (await listed.json()) as { result: { tools: Array<{ name: string }> } };
    expect(payload.result.tools).toHaveLength(11);
    expect(payload.result.tools.map((tool) => tool.name)).toContain('wiki.claim');
  });

  it('rejects a revoked token the same way the REST API does', async () => {
    process.env.MCP_HTTP_ENABLED = 'true';
    const { POST } = await loadRoute();
    const response = await POST(mcpRequest(INITIALIZE, { authorization: `Bearer ${revokedToken}` }));
    expect(response.status).toBe(401);
  });
});
