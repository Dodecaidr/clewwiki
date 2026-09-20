import 'server-only';

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { nextCookies } from 'better-auth/next-js';
import { accounts, sessions, users, verifications } from '@clewwiki/db';

import { getAuthBaseUrl, getAuthSecret, getTrustedClientIpHeader } from './env';
import { getDatabase } from './db';
import {
  OIDC_PROVIDER_ID,
  domainOf,
  identityFromProfile,
  readOidcSettings,
} from './oidc';
import type { OidcSettings } from './oidc';

/**
 * Passwords always, and one OpenID Connect provider when the operator
 * configured it. A self-hosted instance must work with nothing but its own
 * database, so single sign-on is added to password sign-in rather than
 * replacing it: an instance whose provider is down is still an instance its
 * administrator can get into.
 *
 * Agent tokens are deliberately not handled here — see `lib/agent-tokens.ts`.
 *
 * `readOidcSettings` throws on a half-written configuration, and it is called
 * here, at module load, on purpose: an instance that was meant to have single
 * sign-on and silently does not is worse than one that refuses to start.
 */
const oidc: OidcSettings | null = readOidcSettings();

/** Whether the sign-in page should offer the button. */
export function oidcProvider(): { name: string } | null {
  return oidc === null ? null : { name: oidc.name };
}

function oidcPlugins(settings: OidcSettings) {
  return genericOAuth({
    config: [
      {
        providerId: OIDC_PROVIDER_ID,
        name: settings.name,
        discoveryUrl: settings.discoveryUrl,
        clientId: settings.clientId,
        clientSecret: settings.clientSecret,
        scopes: settings.scopes,
        // Identity here is the ID token's `sub`, so a discovery document that
        // does not carry what verifies an ID token must fail loudly rather
        // than fall back to decoding one unverified.
        requireIdTokenVerification: true,
        // An account is an administrator's decision. Turning provisioning on
        // is the operator saying that anybody the provider vouches for may
        // have one; off, this refuses a stranger instead of creating a row.
        disableSignUp: !settings.signUp,
        // The provider is the directory of names; it does not get to rewrite a
        // name somebody set here.
        overrideUserInfo: false,
        mapProfileToUser: (profile) => {
          try {
            const identity = identityFromProfile(profile, settings);
            // Verified at the provider, and this instance says so about its
            // own row too: it is what lets an invited member's account be
            // linked to their identity there instead of being a second one.
            return { email: identity.email, name: identity.name, emailVerified: true };
          } catch (error) {
            console.warn(
              '[sso] refused a sign-in',
              error instanceof Error ? error.message : error,
              `domain=${domainOf(profile.email)}`,
            );
            throw error;
          }
        },
      },
    ],
  });
}
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
    ipAddress: {
      // The library's own rate limiter keys on the client address. By default
      // it reads `X-Forwarded-For`, whose first entry the client controls, so
      // it is pointed at the one header the reverse proxy is trusted to
      // overwrite. When that header is absent every client shares one bucket,
      // which is the safe failure.
      ipAddressHeaders: [getTrustedClientIpHeader()],
    },
  },
  account: {
    accountLinking: {
      // An OpenID Connect sign-in lands on the account that already has the
      // address rather than making a second one. Both sides must say the
      // address is verified: the provider through `email_verified`, which
      // `identityFromProfile` refuses to do without, and this instance through
      // the row itself, which only an administrator's invitation or `/setup`
      // can create — see `docs/security.md`.
      enabled: true,
      trustedProviders: [OIDC_PROVIDER_ID],
      allowDifferentEmails: false,
    },
  },
  trustedOrigins: [getAuthBaseUrl()],
  // Accounts come into existence through /setup (the first) and through an
  // invitation (`lib/members`), both of which call the sign-up endpoint
  // server-side (`auth.api`, not the HTTP router). Closing the public route
  // means nobody can register themselves — before setup, when an
  // account created this way would lock the operator out of /setup, or after.
  disabledPaths: ['/sign-up/email'],
  // `nextCookies` must stay last, so the provider plugin goes before it.
  plugins: [...(oidc === null ? [] : [oidcPlugins(oidc)]), nextCookies()],
});

export type Auth = typeof auth;
