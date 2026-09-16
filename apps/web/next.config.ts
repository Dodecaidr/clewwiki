import path from 'node:path';
import { fileURLToPath } from 'node:url';

import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  // Required by the Docker image: emits a self-contained server bundle.
  output: 'standalone',
  // The app lives in a workspace, so tracing has to start at the repo root or
  // the standalone bundle misses the linked packages.
  outputFileTracingRoot: path.join(rootDir, '..', '..'),
  transpilePackages: ['@clewwiki/db'],
  // The Postgres driver opens raw sockets and must not be bundled.
  serverExternalPackages: ['postgres'],
  poweredByHeader: false,
  typescript: {
    ignoreBuildErrors: false,
  },
  async headers() {
    // Content-Security-Policy and HSTS are set per request in `proxy.ts`,
    // because the former needs a fresh nonce and the latter depends on
    // whether the reverse proxy in front of us terminated TLS.
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
          },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
      {
        source: '/api/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
