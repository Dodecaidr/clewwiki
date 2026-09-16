import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Per-request security headers.
 *
 * Static headers live in `next.config.ts`; the two that cannot be static are
 * here. Content-Security-Policy needs a fresh nonce per response, and
 * Strict-Transport-Security must only be sent when a reverse proxy actually
 * terminated TLS — the application never does, and announcing HSTS over plain
 * HTTP would lock an operator out of their own instance.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const isDev = process.env.NODE_ENV !== 'production';

  const directives = [
    "default-src 'self'",
    // `strict-dynamic` lets the nonce-tagged Next bootstrap load the rest of
    // the bundle. Development additionally needs `unsafe-eval` for the
    // bundler's hot-reload runtime.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    // Next inlines critical CSS with a style attribute it does not nonce.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];

  const csp = directives.join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);

  if (request.headers.get('x-forwarded-proto') === 'https') {
    response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except build assets and the Next image optimizer, which carry
    // no HTML and are served with their own immutable caching headers.
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
