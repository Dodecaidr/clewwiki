import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for the clewwiki REST API, small enough to read in one sitting.
 *
 * It exists so the MCP server can be exercised end to end — spawned as a
 * process, driven by a real MCP client — without a PostgreSQL instance behind
 * it. It enforces the two things the wrapper is supposed to respect and
 * nothing else: a bearer token must be present, and a write must carry both a
 * live claim and a matching base hash.
 */

export interface FakeRestOptions {
  /** Token the server accepts. Anything else is `invalid_token`. */
  token: string;
  /** Scopes the token carries; a call needing more answers `insufficient_scope`. */
  scopes?: string[];
}

export interface RecordedCall {
  method: string;
  path: string;
  authorization: string | null;
  userAgent: string | null;
  body: unknown;
}

interface FakePage {
  page_id: string;
  parent_id: null;
  path: string;
  title: string;
  kind: 'technical' | 'human';
  summary: string | null;
  content_hash: string;
  version: number;
  created_at: string;
  created_by: { type: 'user'; id: string };
  updated_at: string;
  updated_by: { type: 'agent'; id: string };
  body: string;
  anchors: never[];
}

interface FakeClaim {
  claim_id: string;
  page_id: string;
  held_by: string;
  actor_type: 'agent';
  holder_id: string;
  since: string;
  expires_at: string;
  base_content_hash: string;
  released: boolean;
}

export interface FakeRest {
  url: string;
  calls: RecordedCall[];
  page: FakePage;
  close(): Promise<void>;
}

function hashOf(body: string): string {
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

export async function startFakeRest(options: FakeRestOptions): Promise<FakeRest> {
  const scopes = options.scopes ?? ['pages:read', 'pages:write'];
  const calls: RecordedCall[] = [];

  const page: FakePage = {
    page_id: randomUUID(),
    parent_id: null,
    path: '/backend/auth',
    title: 'Authentication',
    kind: 'technical',
    summary: 'How sign-in works.',
    content_hash: hashOf('# Authentication\n'),
    version: 1,
    created_at: new Date('2024-01-01T00:00:00Z').toISOString(),
    created_by: { type: 'user', id: 'user-1' },
    updated_at: new Date('2024-01-01T00:00:00Z').toISOString(),
    updated_by: { type: 'agent', id: 'token-1' },
    body: '# Authentication\n',
    anchors: [],
  };
  const claims = new Map<string, FakeClaim>();

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = undefined;
      if (raw.trim() !== '') {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }

      const url = new URL(req.url ?? '/', 'http://fake.local');
      calls.push({
        method: req.method ?? 'GET',
        path: url.pathname + url.search,
        authorization: req.headers.authorization ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        body,
      });

      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const fail = (status: number, code: string, message: string, details?: unknown) =>
        send(status, { error: { code, message, ...(details ? { details } : {}) } });

      if (req.headers.authorization !== `Bearer ${options.token}`) {
        return fail(401, 'invalid_token', 'Invalid or expired token');
      }

      const needs = (scope: string): boolean => {
        if (scopes.includes(scope)) return true;
        fail(403, 'insufficient_scope', `Token is missing scope: ${scope}`);
        return false;
      };

      const method = req.method ?? 'GET';
      const path = url.pathname;

      if (method === 'GET' && path === '/api/v1/pages') {
        if (!needs('pages:read')) return;
        const wanted = url.searchParams.get('path');
        const nodes =
          wanted === null || wanted === page.path
            ? [
                {
                  page_id: page.page_id,
                  parent_id: null,
                  path: page.path,
                  title: page.title,
                  kind: page.kind,
                  updated_at: page.updated_at,
                  has_children: false,
                  stale_anchor_count: 0,
                  claimed: [...claims.values()].some((claim) => !claim.released),
                },
              ]
            : [];
        return send(200, { nodes });
      }

      if (method === 'GET' && path === '/api/v1/search') {
        if (!needs('pages:read')) return;
        return send(200, {
          query: url.searchParams.get('q'),
          results: [
            {
              page_id: page.page_id,
              path: page.path,
              title: page.title,
              kind: page.kind,
              snippet: page.body,
              content_hash: page.content_hash,
              updated_at: page.updated_at,
            },
          ],
        });
      }

      if (method === 'GET' && path === `/api/v1/pages/${page.page_id}`) {
        if (!needs('pages:read')) return;
        const active = [...claims.values()].find((claim) => !claim.released) ?? null;
        return send(200, { ...page, linked_page: null, claim: active });
      }

      if (method === 'POST' && path === `/api/v1/pages/${page.page_id}/claims`) {
        if (!needs('pages:write')) return;
        const existing = [...claims.values()].find((claim) => !claim.released);
        if (existing) {
          return fail(409, 'conflict', 'Page is claimed', {
            held_by: existing.held_by,
            actor_type: existing.actor_type,
            since: existing.since,
            expires_at: existing.expires_at,
          });
        }
        const claim: FakeClaim = {
          claim_id: randomUUID(),
          page_id: page.page_id,
          held_by: 'test-agent',
          actor_type: 'agent',
          holder_id: 'token-1',
          since: new Date().toISOString(),
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          base_content_hash: page.content_hash,
          released: false,
        };
        claims.set(claim.claim_id, claim);
        return send(201, { ...claim, path: page.path, title: page.title });
      }

      if (method === 'PATCH' && path === `/api/v1/pages/${page.page_id}`) {
        if (!needs('pages:write')) return;
        const payload = (body ?? {}) as { claim_id?: string; base_content_hash?: string; body?: string; title?: string };
        const claim = payload.claim_id ? claims.get(payload.claim_id) : undefined;
        if (!claim || claim.released) {
          return fail(409, 'conflict', 'No live claim on this page');
        }
        if (payload.base_content_hash !== page.content_hash) {
          return fail(409, 'stale_base', 'Page changed since the base hash was read', {
            current_content_hash: page.content_hash,
            your_base_hash: payload.base_content_hash,
          });
        }
        page.body = payload.body ?? page.body;
        if (payload.title) page.title = payload.title;
        page.content_hash = hashOf(page.body);
        page.version += 1;
        page.updated_at = new Date().toISOString();
        claim.base_content_hash = page.content_hash;
        return send(200, { ...page, linked_page: null });
      }

      if (method === 'PATCH' && path.startsWith('/api/v1/claims/')) {
        if (!needs('pages:write')) return;
        const claim = claims.get(path.slice('/api/v1/claims/'.length));
        if (!claim || claim.released) return fail(404, 'not_found', 'Claim not found');
        claim.expires_at = new Date(Date.now() + 600_000).toISOString();
        return send(200, claim);
      }

      if (method === 'DELETE' && path.startsWith('/api/v1/claims/')) {
        if (!needs('pages:write')) return;
        const claimId = path.slice('/api/v1/claims/'.length);
        const claim = claims.get(claimId);
        if (!claim) return fail(404, 'not_found', 'Claim not found');
        const alreadyReleased = claim.released;
        claim.released = true;
        return send(200, {
          claim_id: claimId,
          released: true,
          already_released: alreadyReleased,
          notes_deleted: 0,
        });
      }

      if (method === 'GET' && path === '/api/v1/claims') {
        if (!needs('pages:read')) return;
        return send(200, { claims: [...claims.values()].filter((claim) => !claim.released) });
      }

      if (method === 'POST' && path === `/api/v1/pages/${page.page_id}/notes`) {
        if (!needs('pages:write')) return;
        const payload = (body ?? {}) as { claim_id?: string; text?: string };
        const claim = payload.claim_id ? claims.get(payload.claim_id) : undefined;
        if (!claim || claim.released) return fail(404, 'not_found', 'Claim not found');
        return send(201, {
          note_id: randomUUID(),
          text: payload.text,
          author: 'test-agent',
          author_type: 'agent',
          created_at: new Date().toISOString(),
          expires_at: claim.expires_at,
        });
      }

      if (method === 'POST' && path === `/api/v1/pages/${page.page_id}/anchors/check`) {
        if (!needs('pages:write')) return;
        // An older instance still quoted the remote's stderr here; the MCP
        // boundary must not pass it on.
        return fail(502, 'repository_unavailable', 'The repository could not be reached', {
          git: 'fatal: could not read from remote repository',
        });
      }

      if (method === 'POST' && path === `/api/v1/pages/${page.page_id}/link`) {
        if (!needs('pages:write')) return;
        const payload = (body ?? {}) as { linked_page_id?: string | null };
        return send(200, { page_id: page.page_id, linked_page_id: payload.linked_page_id ?? null });
      }

      return fail(404, 'not_found', 'Resource not found');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    page,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
