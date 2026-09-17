import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping /api/v1/me suite: ${probe.reason}`);
}

// Configured before the application modules load: `lib/auth.ts` refuses to
// initialise without a secret, by design.
process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
process.env.AGENT_TOKEN_RATE_LIMIT_MAX ??= '1000';

describe.skipIf(!probe.reachable)('GET /api/v1/me with an agent token', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let GET: (request: Request) => Promise<Response>;

  const suiteTag = `it-${randomUUID().slice(0, 8)}`;
  const workspaceIds: string[] = [];

  interface SeededToken {
    id: string;
    token: string;
  }

  async function seedToken(options: {
    workspaceId: string;
    name: string;
    scopes: string[];
    expiresAt?: Date | null;
    revokedAt?: Date | null;
  }): Promise<SeededToken> {
    const { generateAgentToken } = await import('@/lib/agent-token-crypto');
    const generated = generateAgentToken();
    const [row] = await db
      .insert(schema.agentTokens)
      .values({
        workspaceId: options.workspaceId,
        name: options.name,
        prefix: generated.prefix,
        tokenHash: generated.tokenHash,
        scopes: options.scopes,
        expiresAt: options.expiresAt ?? null,
        revokedAt: options.revokedAt ?? null,
      })
      .returning({ id: schema.agentTokens.id });
    return { id: row!.id, token: generated.token };
  }

  async function callMe(headers: HeadersInit = {}): Promise<Response> {
    return GET(new Request('http://localhost:3000/api/v1/me', { headers }));
  }

  let primaryWorkspaceId: string;
  let otherWorkspaceId: string;
  let validToken: SeededToken;
  let expiredToken: SeededToken;
  let revokedToken: SeededToken;
  let noScopeToken: SeededToken;
  let otherWorkspaceToken: SeededToken;

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    db = schema.getDatabase();
    ({ GET } = await import('@/app/api/v1/me/route'));

    const [primary] = await db
      .insert(schema.workspaces)
      .values({ name: `Primary ${suiteTag}`, slug: `${suiteTag}-primary` })
      .returning({ id: schema.workspaces.id });
    const [other] = await db
      .insert(schema.workspaces)
      .values({ name: `Other ${suiteTag}`, slug: `${suiteTag}-other` })
      .returning({ id: schema.workspaces.id });

    primaryWorkspaceId = primary!.id;
    otherWorkspaceId = other!.id;
    workspaceIds.push(primaryWorkspaceId, otherWorkspaceId);

    validToken = await seedToken({
      workspaceId: primaryWorkspaceId,
      name: 'valid',
      scopes: ['identity:read', 'pages:read'],
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    expiredToken = await seedToken({
      workspaceId: primaryWorkspaceId,
      name: 'expired',
      scopes: ['identity:read'],
      expiresAt: new Date(Date.now() - 60 * 1000),
    });
    revokedToken = await seedToken({
      workspaceId: primaryWorkspaceId,
      name: 'revoked',
      scopes: ['identity:read'],
      revokedAt: new Date(Date.now() - 60 * 1000),
    });
    noScopeToken = await seedToken({
      workspaceId: primaryWorkspaceId,
      name: 'no-scope',
      scopes: ['pages:read'],
    });
    otherWorkspaceToken = await seedToken({
      workspaceId: otherWorkspaceId,
      name: 'other-workspace',
      scopes: ['identity:read'],
    });
  });

  afterAll(async () => {
    if (!probe.reachable || !schema) return;
    const { inArray } = await import('drizzle-orm');
    if (workspaceIds.length > 0) {
      // Tokens and audit rows cascade from the workspace.
      await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, workspaceIds));
    }
    await schema.getDatabaseHandle().sql.end({ timeout: 5 });
  });

  it('accepts a valid token and reports its identity, scopes and workspace', async () => {
    const response = await callMe({ Authorization: `Bearer ${validToken.token}` });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.actor).toMatchObject({ type: 'agent', id: validToken.id, name: 'valid' });
    expect(body.role).toBe('agent');
    expect(body.scopes).toEqual(['identity:read', 'pages:read']);
    expect(body.workspace.id).toBe(primaryWorkspaceId);
  });

  it('never returns the token secret or its hash', async () => {
    const response = await callMe({ Authorization: `Bearer ${validToken.token}` });
    const text = await response.text();
    expect(text).not.toContain(validToken.token);
    expect(text.toLowerCase()).not.toContain('tokenhash');
  });

  it('writes an audit row for the authenticated request', async () => {
    const { and, eq } = await import('drizzle-orm');
    await callMe({ Authorization: `Bearer ${validToken.token}` });

    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.actorId, validToken.id),
          eq(schema.auditLog.action, 'api.request'),
        ),
      );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.workspaceId).toBe(primaryWorkspaceId);
    expect(rows[0]!.target).toBe('/api/v1/me');
    expect(rows[0]!.actorType).toBe('agent');
  });

  it('updates last_used_at on a successful call', async () => {
    const { eq } = await import('drizzle-orm');
    await callMe({ Authorization: `Bearer ${validToken.token}` });

    const [row] = await db
      .select({ lastUsedAt: schema.agentTokens.lastUsedAt })
      .from(schema.agentTokens)
      .where(eq(schema.agentTokens.id, validToken.id));

    expect(row?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('rejects an expired token at the authentication layer', async () => {
    const response = await callMe({ Authorization: `Bearer ${expiredToken.token}` });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('invalid_token');
  });

  it('rejects a revoked token at the authentication layer', async () => {
    const response = await callMe({ Authorization: `Bearer ${revokedToken.token}` });
    expect(response.status).toBe(401);
  });

  it('records rejected tokens in the audit log', async () => {
    const { and, eq } = await import('drizzle-orm');
    await callMe({ Authorization: `Bearer ${revokedToken.token}` });

    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.actorId, revokedToken.id),
          eq(schema.auditLog.action, 'auth.rejected'),
        ),
      );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.metadata).toMatchObject({ reason: 'revoked' });
  });

  it('coalesces a burst of rejected calls into one audit row per token', async () => {
    const { and, eq } = await import('drizzle-orm');
    const burst = await seedToken({
      workspaceId: primaryWorkspaceId,
      name: 'revoked-burst',
      scopes: ['identity:read'],
      revokedAt: new Date(Date.now() - 60 * 1000),
    });
    for (let call = 0; call < 25; call += 1) {
      expect((await callMe({ Authorization: `Bearer ${burst.token}` })).status).toBe(401);
    }
    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.actorId, burst.id), eq(schema.auditLog.action, 'auth.rejected')));
    expect(rows).toHaveLength(1);
  });

  it('coalesces rate-limited calls into one audit row per token per window', async () => {
    const { and, eq } = await import('drizzle-orm');
    const { TokenBucketRateLimiter } = await import('@/lib/rate-limit');
    const previous = globalThis.__clewwikiAgentRateLimiter;
    globalThis.__clewwikiAgentRateLimiter = new TokenBucketRateLimiter(1, 60);
    try {
      const busy = await seedToken({
        workspaceId: primaryWorkspaceId,
        name: 'busy',
        scopes: ['identity:read'],
      });
      const statuses: number[] = [];
      for (let call = 0; call < 20; call += 1) {
        statuses.push((await callMe({ Authorization: `Bearer ${busy.token}` })).status);
      }
      expect(statuses[0]).toBe(200);
      expect(statuses.slice(1).every((status) => status === 429)).toBe(true);

      const rows = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.actorId, busy.id), eq(schema.auditLog.action, 'auth.rate_limited')));
      expect(rows).toHaveLength(1);
    } finally {
      globalThis.__clewwikiAgentRateLimiter = previous;
    }
  });

  it('rejects a token whose secret has been tampered with', async () => {
    const [head, secret] = validToken.token.split('.');
    const tampered = `${head}.${'A'.repeat(secret!.length)}`;
    const response = await callMe({ Authorization: `Bearer ${tampered}` });
    expect(response.status).toBe(401);
  });

  it('rejects an unknown and a malformed token', async () => {
    expect(
      (await callMe({ Authorization: 'Bearer cww_zzzzzzzz.zzzzzzzzzzzzzzzzzzzz' })).status,
    ).toBe(401);
    expect((await callMe({ Authorization: 'Bearer not-a-token' })).status).toBe(401);
  });

  it('rejects a request with no credentials at all', async () => {
    const response = await callMe();
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('Bearer');
  });

  it('rejects a token that lacks the required scope', async () => {
    const response = await callMe({ Authorization: `Bearer ${noScopeToken.token}` });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('insufficient_scope');
  });

  it('scopes the answer to the token workspace, never another one', async () => {
    const response = await callMe({ Authorization: `Bearer ${otherWorkspaceToken.token}` });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.workspace.id).toBe(otherWorkspaceId);
    expect(body.workspace.id).not.toBe(primaryWorkspaceId);
  });
});
