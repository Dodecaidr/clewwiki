import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { buildContentSecurityPolicy, externalImagesAllowed } from '@/lib/csp';

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

  const csp = buildContentSecurityPolicy({
    nonce,
    isDev,
    allowExternalImages: externalImagesAllowed(),
  });

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
    // no HTML and are served with their own immutable caching headers — and
    // the two endpoints that take large uploads. A request that passes through
    // here has its body buffered in memory, and cut at 10 MB without an error,
    // so that both this function and the handler could read it. An import or a
    // file is read by its handler alone, as a stream, and answers with headers
    // of its own.
    {
      source: '/((?!_next/static|_next/image|favicon.ico|api/v1/pages/[^/]+/files/|api/v1/spaces/[^/]+/imports$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
