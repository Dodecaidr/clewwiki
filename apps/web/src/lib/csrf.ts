/**
 * Cross-site request checks for REST calls authenticated by the session cookie.
 *
 * A cookie is ambient: the browser attaches it to a request some other page
 * started. `SameSite=Lax` stops most of that, but "site" is the registrable
 * domain, so a page on a sibling subdomain (`blog.example.com` next to
 * `wiki.example.com`) is same-site and gets the cookie. So a cookie-
 * authenticated request that changes state must also prove it came from this
 * origin, and must be JSON — which a plain HTML form cannot send and a
 * cross-origin `fetch` cannot send without a CORS preflight this API never
 * answers.
 *
 * Bearer-token requests are not checked here: a token is never attached by a
 * browser on its own, so there is nothing to forge.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type CsrfDecision = { ok: true } | { ok: false; message: string };

interface RequestLike {
  method: string;
  headers: { get(name: string): string | null };
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function checkSessionMutation(request: RequestLike, baseUrl: string): CsrfDecision {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return { ok: true };

  const expected = originOf(baseUrl);
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');

  const sameOrigin =
    fetchSite === 'same-origin' || (origin !== null && expected !== null && origin === expected);
  if (!sameOrigin) {
    return { ok: false, message: 'Cross-origin request refused for a cookie-authenticated call' };
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/json\s*(;|$)/i.test(contentType.trim())) {
    return { ok: false, message: 'Content-Type must be application/json' };
  }
  return { ok: true };
}
