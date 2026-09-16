import 'server-only';

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { accounts, sessions, users, verifications } from '@clewwiki/db';

import { getAuthBaseUrl, getAuthSecret } from './env';
import { getDatabase } from './db';

/**
 * Credentials-only authentication for human accounts. No external identity
 * provider is configured, and none is optional-at-runtime either: a
 * self-hosted instance must work with nothing but its own database.
 *
 * Agent tokens are deliberately not handled here — see `lib/agent-tokens.ts`.
 */
export const auth = betterAuth({
  appName: 'clewwiki',
  secret: getAuthSecret(),
  baseURL: getAuthBaseUrl(),
  basePath: '/api/auth',
  database: drizzleAdapter(getDatabase(), {
    provider: 'pg',
    schema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
    },
  }),
  emailAndPassword: {
    enabled: true,
    // Self-hosted instances have no mail transport by default, so an
    // unverifiable address must not lock the only admin out.
    requireEmailVerification: false,
    minPasswordLength: 12,
    maxPasswordLength: 256,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  advanced: {
    // Secure cookies need TLS in front of the app. Trusting the configured
    // base URL avoids setting a cookie the browser will silently drop on a
    // plain-HTTP deployment.
    useSecureCookies: getAuthBaseUrl().startsWith('https://'),
    defaultCookieAttributes: {
      sameSite: 'lax',
      httpOnly: true,
    },
  },
  trustedOrigins: [getAuthBaseUrl()],
  // `nextCookies` must stay last: it flushes Set-Cookie headers produced by
  // server actions.
  plugins: [nextCookies()],
});

export type Auth = typeof auth;
