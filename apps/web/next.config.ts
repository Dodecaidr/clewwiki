import path from 'node:path';
import { fileURLToPath } from 'node:url';

import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  // The dev server otherwise writes agent-context files of its own into this
  // directory on every start. This repository keeps exactly one such file, at
  // the root, written and reviewed like any other content — so the generator
  // is turned off rather than its output repeatedly deleted.
  agentRules: false,
  // Required by the Docker image: emits a self-contained server bundle.
  output: 'standalone',
  // The app lives in a workspace, so tracing has to start at the repo root or
  // the standalone bundle misses the linked packages.
  outputFileTracingRoot: path.join(rootDir, '..', '..'),
  transpilePackages: [
    '@clewwiki/db',
    '@clewwiki/anchors',
    '@clewwiki/content',
    '@clewwiki/import',
    '@clewwiki/mcp-server',
  ],
  // The Postgres driver opens raw sockets and must not be bundled. The
  // tree-sitter runtime is an Emscripten module that loads its own
  // WebAssembly; bundling it rewrites the module layout it depends on. `unpdf`
  // ships a serverless PDF.js build that resolves its own standard fonts and
  // character maps at run time from its package directory, which only survives
  // if the package stays a package.
  serverExternalPackages: ['postgres', 'web-tree-sitter', 'unpdf'],
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
