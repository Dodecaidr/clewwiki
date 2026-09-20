/**
 * Single sign-on over OpenID Connect: what the operator configured, and what a
 * profile has to carry before it becomes a session here.
 *
 * Everything in this file is a pure function of an environment and a profile,
 * with no database and no library, because these are the decisions worth being
 * able to test: which provider is trusted, who is allowed in, and what counts
 * as proof that an address belongs to the person signing in. The wiring that
 * uses them is in `lib/auth.ts` and `app/sso/page.tsx`.
 *
 * Three rules, and none of them is optional:
 *
 * 1. **The address must be verified by the provider.** A profile without
 *    `email_verified` is refused. The address is how an identity at the
 *    provider is matched to an account here, so an unverified one is a way to
 *    claim somebody else's account by setting an address at the provider.
 * 2. **Signing in is not signing up.** A person who has no account here is
 *    refused unless the operator turned provisioning on. That keeps the
 *    product's rule — accounts come from an administrator — true by default,
 *    rather than handing every account at the company's provider a membership.
 * 3. **The domain list, when set, is a list.** Some providers are shared with
 *    people outside the company; `OIDC_ALLOWED_EMAIL_DOMAINS` is how an
 *    operator says which addresses this instance accepts at all.
 */

import type { MembershipRole } from '@clewwiki/db';

export const OIDC_PROVIDER_ID = 'oidc';

/** Where the provider sends the person back. Register this at the provider. */
export function oidcRedirectPath(): string {
  return `/api/auth/callback/${OIDC_PROVIDER_ID}`;
}

export interface OidcSettings {
  /** Shown on the sign-in button. */
  name: string;
  /** The OpenID Connect discovery document. */
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  /** Whether a person with no account here gets one on first sign-in. */
  signUp: boolean;
  /** The role such an account is given. */
  signUpRole: MembershipRole;
  /** Address domains allowed in, lower-case and without the `@`. Empty means all. */
  allowedDomains: string[];
}

const ROLES: MembershipRole[] = ['admin', 'editor', 'viewer'];
const DISCOVERY_PATH = '/.well-known/openid-configuration';

/** Why a sign-in was refused. The person sees a sentence; this is for the log. */
export type OidcRefusal = 'no-email' | 'unverified-email' | 'domain' | 'no-name';

export class OidcSignInError extends Error {
  constructor(readonly refusal: OidcRefusal) {
    super(`single sign-on refused: ${refusal}`);
    this.name = 'OidcSignInError';
  }
}

/** A misconfiguration, reported once at startup rather than at sign-in time. */
export class OidcConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OidcConfigError';
  }
}

function trimmed(env: NodeJS.ProcessEnv | Record<string, string | undefined>, key: string): string {
  return (env[key] ?? '').trim();
}

/**
 * The provider, or `null` when none is configured.
 *
 * Off is the default and the safe state: an instance with nothing set here has
 * password sign-in and nothing else. Half a configuration is an error rather
 * than a quiet `null`, because an operator who set two of the three variables
 * meant to turn this on and should be told which one is missing.
 */
export function readOidcSettings(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): OidcSettings | null {
  const issuer = trimmed(env, 'OIDC_ISSUER');
  const clientId = trimmed(env, 'OIDC_CLIENT_ID');
  const clientSecret = trimmed(env, 'OIDC_CLIENT_SECRET');
  if (issuer === '' && clientId === '' && clientSecret === '') return null;

  const missing = [
    issuer === '' ? 'OIDC_ISSUER' : null,
    clientId === '' ? 'OIDC_CLIENT_ID' : null,
    clientSecret === '' ? 'OIDC_CLIENT_SECRET' : null,
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    throw new OidcConfigError(`Single sign-on is half configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing`);
  }

  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    throw new OidcConfigError('OIDC_ISSUER is not a URL');
  }
  // The client secret and the code travel to this address, and the ID token
  // comes back from it.
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new OidcConfigError('OIDC_ISSUER must use https');
  }

  const signUpRole = trimmed(env, 'OIDC_SIGN_UP_ROLE').toLowerCase();
  if (signUpRole !== '' && !ROLES.includes(signUpRole as MembershipRole)) {
    throw new OidcConfigError(`OIDC_SIGN_UP_ROLE must be one of ${ROLES.join(', ')}`);
  }

  const scopes = trimmed(env, 'OIDC_SCOPES')
    .split(/[\s,]+/)
    .filter((scope) => scope !== '');

  return {
    name: trimmed(env, 'OIDC_NAME') || 'Single sign-on',
    discoveryUrl: discoveryUrlOf(parsed),
    clientId,
    clientSecret,
    // `openid` is what makes this OpenID Connect rather than bare OAuth, so it
    // is added back whatever the operator listed.
    scopes: scopes.length === 0 ? ['openid', 'profile', 'email'] : [...new Set(['openid', ...scopes])],
    signUp: trimmed(env, 'OIDC_SIGN_UP') === 'true',
    signUpRole: (signUpRole === '' ? 'viewer' : signUpRole) as MembershipRole,
    allowedDomains: trimmed(env, 'OIDC_ALLOWED_EMAIL_DOMAINS')
      .split(',')
      .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
      .filter((domain) => domain !== ''),
  };
}

/** The discovery document of an issuer, whichever of the two an operator pasted. */
export function discoveryUrlOf(issuer: URL): string {
  const base = `${issuer.origin}${issuer.pathname.replace(/\/+$/, '')}`;
  return base.endsWith(DISCOVERY_PATH) ? base : `${base}${DISCOVERY_PATH}`;
}

/** Claims of an OpenID Connect profile, as they arrive: unknown until checked. */
export interface OidcProfile {
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  given_name?: unknown;
  family_name?: unknown;
  preferred_username?: unknown;
  [claim: string]: unknown;
}

export interface OidcIdentity {
  email: string;
  name: string;
}

/**
 * The account fields of a profile, or a refusal.
 *
 * `email_verified` is accepted as the boolean it is meant to be and as the
 * string some providers send instead; anything else is unverified. The name
 * falls back through the claims a provider might fill and finally to the local
 * part of the address, because a person needs something to be called and an
 * empty name is not it.
 */
export function identityFromProfile(profile: OidcProfile, settings: OidcSettings): OidcIdentity {
  const email = typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : '';
  if (email === '' || !email.includes('@')) throw new OidcSignInError('no-email');

  const verified = profile.email_verified;
  if (!(verified === true || verified === 'true')) throw new OidcSignInError('unverified-email');

  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (settings.allowedDomains.length > 0 && !settings.allowedDomains.includes(domain)) {
    throw new OidcSignInError('domain');
  }

  const name = firstString([
    profile.name,
    joinNames(profile.given_name, profile.family_name),
    profile.preferred_username,
    email.slice(0, email.lastIndexOf('@')),
  ]);
  if (name === null) throw new OidcSignInError('no-name');

  return { email, name: name.slice(0, 100) };
}

function joinNames(given: unknown, family: unknown): string {
  return [given, family].filter((part): part is string => typeof part === 'string' && part.trim() !== '').join(' ');
}

function firstString(candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return null;
}

/** The domain of an address, for a log line that says why without saying who. */
export function domainOf(email: unknown): string {
  return typeof email === 'string' && email.includes('@') ? email.slice(email.lastIndexOf('@') + 1) : 'unknown';
}
