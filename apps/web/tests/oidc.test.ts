import { describe, expect, it } from 'vitest';

import {
  OIDC_PROVIDER_ID,
  OidcConfigError,
  OidcSignInError,
  identityFromProfile,
  oidcRedirectPath,
  readOidcSettings,
} from '@/lib/oidc';
import type { OidcSettings } from '@/lib/oidc';

/**
 * The two decisions single sign-on rests on: which provider this instance
 * trusts, and who the provider is allowed to let in. Both are pure functions of
 * an environment and a profile, which is why they are tested here rather than
 * against a live identity provider.
 */

const configured = {
  OIDC_ISSUER: 'https://id.example.com',
  OIDC_CLIENT_ID: 'clewwiki',
  OIDC_CLIENT_SECRET: 'secret',
};

const settings = (over: Partial<OidcSettings> = {}): OidcSettings => ({
  ...(readOidcSettings(configured) as OidcSettings),
  ...over,
});

describe('reading the provider out of the environment', () => {
  it('is off when nothing is set', () => {
    expect(readOidcSettings({})).toBeNull();
  });

  it('refuses half a configuration, naming what is missing', () => {
    expect(() => readOidcSettings({ OIDC_ISSUER: 'https://id.example.com' })).toThrow(OidcConfigError);
    try {
      readOidcSettings({ OIDC_ISSUER: 'https://id.example.com', OIDC_CLIENT_ID: 'x' });
    } catch (error) {
      expect((error as Error).message).toMatch(/OIDC_CLIENT_SECRET/);
      expect((error as Error).message).not.toMatch(/OIDC_CLIENT_ID/);
    }
  });

  it('refuses an issuer that is not https, because the secret travels there', () => {
    expect(() => readOidcSettings({ ...configured, OIDC_ISSUER: 'http://id.example.com' })).toThrow(
      /https/,
    );
    // Loopback is how somebody tries a provider on their own machine.
    expect(readOidcSettings({ ...configured, OIDC_ISSUER: 'http://localhost:8080' })).not.toBeNull();
  });

  it('finds the discovery document from an issuer, a path, or the document itself', () => {
    const of = (issuer: string) => readOidcSettings({ ...configured, OIDC_ISSUER: issuer })?.discoveryUrl;
    expect(of('https://id.example.com')).toBe('https://id.example.com/.well-known/openid-configuration');
    expect(of('https://id.example.com/')).toBe('https://id.example.com/.well-known/openid-configuration');
    expect(of('https://id.example.com/realms/team')).toBe(
      'https://id.example.com/realms/team/.well-known/openid-configuration',
    );
    expect(of('https://id.example.com/.well-known/openid-configuration')).toBe(
      'https://id.example.com/.well-known/openid-configuration',
    );
  });

  it('defaults to a named button, the OpenID scopes, no provisioning, and the viewer role', () => {
    const read = readOidcSettings(configured);
    expect(read).toMatchObject({
      name: 'Single sign-on',
      scopes: ['openid', 'profile', 'email'],
      signUp: false,
      signUpRole: 'viewer',
      allowedDomains: [],
    });
  });

  it('keeps openid among the scopes however they were written', () => {
    expect(readOidcSettings({ ...configured, OIDC_SCOPES: 'profile, email groups' })?.scopes).toEqual([
      'openid',
      'profile',
      'email',
      'groups',
    ]);
  });

  it('takes provisioning and its role only when they are spelled out', () => {
    expect(readOidcSettings({ ...configured, OIDC_SIGN_UP: 'yes' })?.signUp).toBe(false);
    expect(readOidcSettings({ ...configured, OIDC_SIGN_UP: 'true' })?.signUp).toBe(true);
    expect(readOidcSettings({ ...configured, OIDC_SIGN_UP_ROLE: 'Editor' })?.signUpRole).toBe('editor');
    expect(() => readOidcSettings({ ...configured, OIDC_SIGN_UP_ROLE: 'owner' })).toThrow(OidcConfigError);
  });

  it('reads the domain list as a list', () => {
    expect(
      readOidcSettings({ ...configured, OIDC_ALLOWED_EMAIL_DOMAINS: '@Example.com, partner.example ,' })
        ?.allowedDomains,
    ).toEqual(['example.com', 'partner.example']);
  });

  it('sends the provider back to the one path it is registered for', () => {
    expect(oidcRedirectPath()).toBe(`/api/auth/callback/${OIDC_PROVIDER_ID}`);
  });
});

describe('who a profile is allowed to be', () => {
  const refusalOf = (profile: Record<string, unknown>, over: Partial<OidcSettings> = {}) => {
    try {
      identityFromProfile(profile, settings(over));
      return 'allowed';
    } catch (error) {
      return error instanceof OidcSignInError ? error.refusal : `unexpected: ${String(error)}`;
    }
  };

  it('needs an address', () => {
    expect(refusalOf({ email_verified: true })).toBe('no-email');
    expect(refusalOf({ email: 42, email_verified: true })).toBe('no-email');
    expect(refusalOf({ email: 'not-an-address', email_verified: true })).toBe('no-email');
  });

  it('needs the provider to say the address is verified', () => {
    // Without this an identity at the provider could be given any address, and
    // the address is what matches it to an account here.
    expect(refusalOf({ email: 'ada@example.com' })).toBe('unverified-email');
    expect(refusalOf({ email: 'ada@example.com', email_verified: false })).toBe('unverified-email');
    expect(refusalOf({ email: 'ada@example.com', email_verified: 'yes' })).toBe('unverified-email');
    // Some providers send the claim as a string.
    expect(refusalOf({ email: 'ada@example.com', email_verified: 'true' })).toBe('allowed');
  });

  it('keeps to the domains the operator listed, when there are any', () => {
    const only = { allowedDomains: ['example.com'] };
    expect(refusalOf({ email: 'ada@Example.COM', email_verified: true }, only)).toBe('allowed');
    expect(refusalOf({ email: 'eve@elsewhere.test', email_verified: true }, only)).toBe('domain');
  });

  it('finds a name to call somebody, and falls back rather than leaving it empty', () => {
    const nameOf = (profile: Record<string, unknown>) =>
      identityFromProfile({ email: 'ada@example.com', email_verified: true, ...profile }, settings()).name;
    expect(nameOf({ name: 'Ada Lovelace' })).toBe('Ada Lovelace');
    expect(nameOf({ given_name: 'Ada', family_name: 'Lovelace' })).toBe('Ada Lovelace');
    expect(nameOf({ given_name: 'Ada' })).toBe('Ada');
    expect(nameOf({ preferred_username: 'ada' })).toBe('ada');
    expect(nameOf({})).toBe('ada');
    expect(nameOf({ name: 'x'.repeat(200) })).toHaveLength(100);
  });

  it('lower-cases the address, because that is what it is matched by', () => {
    expect(identityFromProfile({ email: 'Ada@Example.com', email_verified: true }, settings()).email).toBe(
      'ada@example.com',
    );
  });
});
