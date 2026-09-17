import { afterEach, describe, expect, it } from 'vitest';

import { AuditSampler } from '@/lib/audit-sampler';
import { clientKey, resolveClientAddress, SHARED_CLIENT_KEY } from '@/lib/client-address';
import { checkSessionMutation } from '@/lib/csrf';
import { getRepositoryToken, getTrustedClientIpHeader } from '@/lib/env';
import { credentialConfigKey, gitEnvironment } from '@/lib/repository/git';
import { readRepositorySettings, repositorySettingsSchema, repositoryUrlProblem } from '@/lib/repository/settings';
import { ensureSetupToken, setupTokenMatches, clearSetupToken } from '@/lib/setup-token';

const saved = { ...process.env };
afterEach(() => {
  for (const key of [
    'TRUSTED_CLIENT_IP_HEADER',
    'ALLOW_FILE_REPOSITORIES',
    'CLEWWIKI_SETUP_TOKEN',
    'CLEWWIKI_GIT_TOKEN',
    'CLEWWIKI_GIT_TOKEN_DOCS',
    'SOME_SECRET',
  ]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  clearSetupToken();
});

describe('client address', () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);

  it('reads a single address from X-Real-IP by default', () => {
    expect(getTrustedClientIpHeader()).toBe('x-real-ip');
    expect(resolveClientAddress(headers({ 'x-real-ip': '203.0.113.5' }))).toBe('203.0.113.5');
    expect(resolveClientAddress(headers({ 'x-real-ip': '2001:db8::1' }))).toBe('2001:db8::1');
  });

  it('never reads X-Forwarded-For, and refuses lists and garbage in the trusted header', () => {
    expect(resolveClientAddress(headers({ 'x-forwarded-for': '203.0.113.5' }))).toBeNull();
    expect(resolveClientAddress(headers({ 'x-real-ip': '203.0.113.5, 10.0.0.1' }))).toBeNull();
    expect(resolveClientAddress(headers({ 'x-real-ip': 'not-an-address' }))).toBeNull();
    expect(clientKey(headers({ 'x-forwarded-for': '1.2.3.4' }))).toBe(SHARED_CLIENT_KEY);
  });

  it('follows TRUSTED_CLIENT_IP_HEADER', () => {
    process.env.TRUSTED_CLIENT_IP_HEADER = 'CF-Connecting-IP';
    expect(getTrustedClientIpHeader()).toBe('cf-connecting-ip');
    expect(resolveClientAddress(headers({ 'cf-connecting-ip': '198.51.100.7', 'x-real-ip': '1.1.1.1' }))).toBe(
      '198.51.100.7',
    );
  });
});

describe('audit sampling', () => {
  it('writes one row per key per window and counts the rest into the next row', () => {
    const sampler = new AuditSampler(10);
    expect(sampler.sample('t1', 0)).toEqual({ write: true, suppressed: 0 });
    expect(sampler.sample('t1', 1_000).write).toBe(false);
    expect(sampler.sample('t1', 2_000).write).toBe(false);
    expect(sampler.sample('t2', 2_000).write).toBe(true);
    expect(sampler.sample('t1', 10_000)).toEqual({ write: true, suppressed: 2 });
  });
});

describe('cookie-authenticated mutations', () => {
  const base = 'https://wiki.example.com';
  const request = (method: string, entries: Record<string, string>) => ({ method, headers: new Headers(entries) });

  it('lets reads through untouched', () => {
    expect(checkSessionMutation(request('GET', {}), base).ok).toBe(true);
  });

  it('needs the instance origin (or same-origin fetch metadata) and a JSON body', () => {
    const json = { 'content-type': 'application/json; charset=utf-8' };
    expect(checkSessionMutation(request('POST', { ...json, origin: base }), base).ok).toBe(true);
    expect(checkSessionMutation(request('PATCH', { ...json, 'sec-fetch-site': 'same-origin' }), base).ok).toBe(true);
    expect(checkSessionMutation(request('POST', { ...json, origin: 'https://blog.example.com' }), base).ok).toBe(false);
    expect(checkSessionMutation(request('DELETE', json), base).ok).toBe(false);
    expect(checkSessionMutation(request('POST', { origin: base, 'content-type': 'text/plain' }), base).ok).toBe(false);
    expect(
      checkSessionMutation(request('POST', { origin: base, 'content-type': 'application/x-www-form-urlencoded' }), base).ok,
    ).toBe(false);
  });
});

describe('repository credentials', () => {
  it('reads only variables in the CLEWWIKI_GIT_TOKEN namespace, even from a stored setting', () => {
    process.env.SOME_SECRET = 'must-not-leave';
    process.env.CLEWWIKI_GIT_TOKEN = 'git-token';
    process.env.CLEWWIKI_GIT_TOKEN_DOCS = 'docs-token';
    expect(getRepositoryToken('SOME_SECRET')).toBeNull();
    expect(getRepositoryToken('BETTER_AUTH_SECRET')).toBeNull();
    expect(getRepositoryToken('DATABASE_URL')).toBeNull();
    expect(getRepositoryToken('CLEWWIKI_GIT_TOKEN')).toBe('git-token');
    expect(getRepositoryToken('CLEWWIKI_GIT_TOKEN_DOCS')).toBe('docs-token');
  });

  it('refuses any other variable name when the setting is saved', () => {
    const base = { url: 'https://git.example.com/org/repo.git', default_ref: 'main' };
    expect(repositorySettingsSchema.safeParse({ ...base, auth_token_env: 'BETTER_AUTH_SECRET' }).success).toBe(false);
    expect(repositorySettingsSchema.safeParse({ ...base, auth_token_env: 'CLEWWIKI_GIT_TOKENX' }).success).toBe(false);
    expect(repositorySettingsSchema.safeParse({ ...base, auth_token_env: 'CLEWWIKI_GIT_TOKEN_API' }).success).toBe(true);
  });

  it('sends the credential only to the https origin of the repository', () => {
    process.env.CLEWWIKI_GIT_TOKEN = 'git-token';
    process.env.ALLOW_FILE_REPOSITORIES = 'false';
    expect(credentialConfigKey('https://git.example.com/org/repo.git')).toBe('http.https://git.example.com/.extraHeader');
    expect(credentialConfigKey('http://git.example.com/org/repo.git')).toBeNull();
    expect(credentialConfigKey('file:///srv/repo')).toBeNull();

    const plain = gitEnvironment({ url: 'http://git.example.com/r.git', default_ref: 'main', auth_token_env: 'CLEWWIKI_GIT_TOKEN' });
    expect(JSON.stringify(plain)).not.toContain('Authorization');

    const tls = gitEnvironment({ url: 'https://git.example.com/r.git', default_ref: 'main', auth_token_env: 'CLEWWIKI_GIT_TOKEN' });
    expect(Object.values(tls)).toContain('http.https://git.example.com/.extraHeader');
    expect(tls.GIT_ALLOW_PROTOCOL).not.toContain('file');
  });
});

describe('repository URLs', () => {
  it('refuses git://, transport prefixes, leading dashes and embedded credentials', () => {
    expect(repositoryUrlProblem('git://git.example.com/repo.git')).not.toBeNull();
    expect(repositoryUrlProblem('ext::sh -c touch% /tmp/pwned')).not.toBeNull();
    expect(repositoryUrlProblem('--upload-pack=touch /tmp/pwned')).not.toBeNull();
    expect(repositoryUrlProblem('https://user:token@git.example.com/repo.git')).not.toBeNull();
    expect(repositoryUrlProblem('https://token@git.example.com/repo.git')).not.toBeNull();
    expect(repositoryUrlProblem('https://git.example.com/repo.git')).toBeNull();
    expect(repositoryUrlProblem('git@github.com:org/repo.git')).toBeNull();
  });

  it('accepts file:// only while ALLOW_FILE_REPOSITORIES=true, at save and at read time', () => {
    const stored = { repository: { url: 'file:///srv/checkout', default_ref: 'main' } };

    process.env.ALLOW_FILE_REPOSITORIES = 'true';
    expect(repositoryUrlProblem('file:///srv/checkout')).toBeNull();
    expect(readRepositorySettings(stored)).not.toBeNull();

    process.env.ALLOW_FILE_REPOSITORIES = 'false';
    expect(repositoryUrlProblem('file:///srv/checkout')).toMatch(/ALLOW_FILE_REPOSITORIES/);
    expect(readRepositorySettings(stored)).toBeNull();
  });
});

describe('setup token', () => {
  it('generates one token, prints it once, and compares it exactly', () => {
    delete process.env.CLEWWIKI_SETUP_TOKEN;
    const lines: string[] = [];
    const first = ensureSetupToken((line) => lines.push(line));
    const second = ensureSetupToken((line) => lines.push(line));
    expect(second).toBe(first);
    expect(lines).toHaveLength(1);
    expect(first.length).toBeGreaterThanOrEqual(20);
    expect(setupTokenMatches(first, first)).toBe(true);
    expect(setupTokenMatches(first.slice(0, -1), first)).toBe(false);
  });

  it('prefers CLEWWIKI_SETUP_TOKEN and prints nothing', () => {
    process.env.CLEWWIKI_SETUP_TOKEN = 'configured-value';
    const lines: string[] = [];
    expect(ensureSetupToken((line) => lines.push(line))).toBe('configured-value');
    expect(lines).toHaveLength(0);
  });
});
