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

/**
 * The same check for the one endpoint that takes a file.
 *
 * An upload cannot be JSON, so the content-type half of the rule above does not
 * apply — and `multipart/form-data` is exactly what a plain HTML form *can*
 * send cross-origin without a preflight. The origin half therefore has to carry
 * the whole check on its own, and it is tightened to compensate: a matching
 * `Origin` header is required outright, rather than being one of two ways to
 * pass. A browser sends `Origin` on every cross-origin form POST, so a forged
 * submission is refused whether or not it also sets `Sec-Fetch-Site`.
 */
export function checkUploadMutation(request: RequestLike, baseUrl: string): CsrfDecision {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return { ok: true };

  const expected = originOf(baseUrl);
  const origin = request.headers.get('origin');
  if (origin === null || expected === null || origin !== expected) {
    return { ok: false, message: 'Cross-origin request refused for a cookie-authenticated upload' };
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data\s*(;|$)/i.test(contentType.trim())) {
    return { ok: false, message: 'Content-Type must be multipart/form-data' };
  }
  return { ok: true };
}

/** The content types an image upload may declare. What the image *is* gets decided from its bytes. */
const IMAGE_UPLOAD_TYPE = /^image\/(png|jpeg|gif|webp)\s*(;|$)/i;

/**
 * The check for an image upload, whose body is the image itself.
 *
 * None of these content types is one a plain HTML form can send, so a
 * cross-origin page cannot make this request without a preflight, which this
 * application never answers. As with the multipart upload, the content type
 * cannot be JSON and the origin half carries the check: a matching `Origin` is
 * required outright.
 */
export function checkImageUploadMutation(request: RequestLike, baseUrl: string): CsrfDecision {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return { ok: true };

  const expected = originOf(baseUrl);
  const origin = request.headers.get('origin');
  if (origin === null || expected === null || origin !== expected) {
    return { ok: false, message: 'Cross-origin request refused for a cookie-authenticated upload' };
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!IMAGE_UPLOAD_TYPE.test(contentType.trim())) {
    return { ok: false, message: 'Content-Type must be image/png, image/jpeg, image/gif or image/webp' };
  }
  return { ok: true };
}

/**
 * The check for a file upload, whose body is the file and may be of any type.
 *
 * Nothing about the content type can carry this check, so the method does: an
 * upload is a `PUT`, which no HTML form can send and a cross-origin `fetch`
 * cannot send without a preflight this application never answers. On top of
 * that, as for every other upload, a matching `Origin` is required outright.
 */
export function checkFileUploadMutation(request: RequestLike, baseUrl: string): CsrfDecision {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return { ok: true };

  const expected = originOf(baseUrl);
  const origin = request.headers.get('origin');
  if (origin === null || expected === null || origin !== expected) {
    return { ok: false, message: 'Cross-origin request refused for a cookie-authenticated upload' };
  }
  if (request.method.toUpperCase() !== 'PUT') {
    return { ok: false, message: 'A file is uploaded with PUT' };
  }
  return { ok: true };
}
