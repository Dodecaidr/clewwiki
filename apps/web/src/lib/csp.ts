/**
 * The Content-Security-Policy every HTML response carries.
 *
 * Kept apart from `proxy.ts` so the policy can be tested as a value: scripts
 * only from this origin under a per-request nonce, never `unsafe-eval` outside
 * development, no plugins, no framing.
 *
 * Images are the one directive an operator may widen. Pages can reference an
 * image by address — there are no uploads — and by default only this origin's
 * images load, so a page cannot make every reader's browser call a third-party
 * server (a tracking pixel, or an address that learns who read what and when).
 * `ALLOW_EXTERNAL_IMAGES=true` allows images from any `https:` origin for an
 * instance whose operator accepts that trade-off.
 */
export interface ContentSecurityPolicyOptions {
  nonce: string;
  isDev: boolean;
  allowExternalImages: boolean;
}

export function buildContentSecurityPolicy({
  nonce,
  isDev,
  allowExternalImages,
}: ContentSecurityPolicyOptions): string {
  return [
    "default-src 'self'",
    // `strict-dynamic` lets the nonce-tagged Next bootstrap load the rest of
    // the bundle. Development additionally needs `unsafe-eval` for the
    // bundler's hot-reload runtime.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    // Next inlines critical CSS with a style attribute it does not nonce.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${allowExternalImages ? ' https:' : ''}`,
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function externalImagesAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.ALLOW_EXTERNAL_IMAGES === 'true';
}
