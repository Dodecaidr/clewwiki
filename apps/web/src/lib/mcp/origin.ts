/**
 * Origin validation for the streamable HTTP MCP transport.
 *
 * Kept away from the route handler so it can be tested without a database, a
 * session or a running server: it is a decision about one header, and the one
 * thing it must never do is default to permissive.
 */

export type OriginDecision =
  | { allowed: true; origin: null }
  | { allowed: true; origin: string }
  | { allowed: false; origin: string };

/**
 * Decides whether a request may reach `/mcp`.
 *
 * No `Origin` header means no browser sent it — a CLI agent, a CI runner, an
 * SDK client — and it passes. An `Origin` header means a browser did, and it
 * passes only when the operator put that exact origin on the allowlist. The
 * allowlist is empty until someone edits the environment, so until then no
 * page on any site can drive this endpoint with a visitor's credentials.
 */
export function decideOrigin(origin: string | null, allowlist: readonly string[]): OriginDecision {
  if (origin === null || origin.trim() === '') {
    return { allowed: true, origin: null };
  }
  const normalized = origin.trim();
  if (allowlist.includes(normalized)) {
    return { allowed: true, origin: normalized };
  }
  return { allowed: false, origin: normalized };
}

/** The CORS headers an allowed browser origin gets back. Never `*`. */
export function corsHeaders(origin: string | null): Record<string, string> {
  if (origin === null) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}
