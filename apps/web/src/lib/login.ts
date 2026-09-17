import 'server-only';

import { eq, sql } from 'drizzle-orm';
import { users } from '@clewwiki/db';

import { recordAudit } from './audit';
import { getAuditSampler } from './audit-sampler';
import { auth } from './auth';
import { clientKey, resolveClientAddress } from './client-address';
import { getDatabase } from './db';
import { TokenBucketRateLimiter } from './rate-limit';
import { getDefaultWorkspace, getMembershipForUser } from './workspace';

/**
 * Password sign-in for the web UI.
 *
 * The login form is a server action, and a server action calls
 * `auth.api.signInEmail` directly — which never passes through the
 * authentication library's HTTP router and therefore never through its rate
 * limiter. So the limits live here, in front of the password check:
 *
 * - **per account**: ten attempts per fifteen minutes for one e-mail address,
 *   whoever sends them — the bound on guessing one password from many
 *   addresses;
 * - **per client**: thirty attempts per fifteen minutes from one address,
 *   across every account — the bound on spraying one password across many
 *   accounts. The address comes from the header the reverse proxy is trusted
 *   to set (`TRUSTED_CLIENT_IP_HEADER`); without it, every client shares one
 *   bucket rather than trusting an address the client wrote itself.
 *
 * A refused attempt gets exactly the answer a wrong password gets, so the
 * limiter reveals nothing about which accounts exist. Both outcomes are
 * audited: `auth.login_failed` for every wrong password, and
 * `auth.login_rate_limited` coalesced to one row per account per ten seconds.
 *
 * Like the agent-token limiter, the buckets live in the process: several
 * replicas multiply the ceiling.
 */

export const LOGIN_ATTEMPTS_PER_ACCOUNT = 10;
export const LOGIN_ATTEMPTS_PER_CLIENT = 30;
export const LOGIN_WINDOW_SECONDS = 15 * 60;

declare global {
  var __clewwikiLoginByAccount: TokenBucketRateLimiter | undefined;
  var __clewwikiLoginByClient: TokenBucketRateLimiter | undefined;
}

function limiters(): { byAccount: TokenBucketRateLimiter; byClient: TokenBucketRateLimiter } {
  globalThis.__clewwikiLoginByAccount ??= new TokenBucketRateLimiter(
    LOGIN_ATTEMPTS_PER_ACCOUNT,
    LOGIN_WINDOW_SECONDS,
  );
  globalThis.__clewwikiLoginByClient ??= new TokenBucketRateLimiter(
    LOGIN_ATTEMPTS_PER_CLIENT,
    LOGIN_WINDOW_SECONDS,
  );
  return {
    byAccount: globalThis.__clewwikiLoginByAccount,
    byClient: globalThis.__clewwikiLoginByClient,
  };
}

/** Clears both buckets. Tests only. */
export function resetLoginLimits(): void {
  globalThis.__clewwikiLoginByAccount?.reset();
  globalThis.__clewwikiLoginByClient?.reset();
}

let attempts = 0;

export type LoginGate = { allowed: true } | { allowed: false; limitedBy: 'account' | 'client' };

/**
 * Takes one attempt from both buckets. The client bucket is asked first, so a
 * client that is already refused cannot also drain the buckets of the accounts
 * it names.
 */
export function consumeLoginAttempt(account: string, client: string, now = Date.now()): LoginGate {
  const { byAccount, byClient } = limiters();
  attempts += 1;
  if (attempts % 500 === 0) {
    byAccount.prune(now);
    byClient.prune(now);
  }
  if (!byClient.consume(client, now).allowed) return { allowed: false, limitedBy: 'client' };
  if (!byAccount.consume(account, now).allowed) return { allowed: false, limitedBy: 'account' };
  return { allowed: true };
}

export function normalizeAccount(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Where a sign-in event is recorded: the account's own workspace when the
 * account exists, the instance's workspace when it does not. Nothing is
 * recorded before first-run setup, when there is no workspace to attribute to.
 */
async function auditLoginEvent(
  action: 'auth.login_failed' | 'auth.login_rate_limited',
  account: string,
  address: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    const db = getDatabase();
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(sql`lower(${users.email})`, account))
      .limit(1);
    const membership = user ? await getMembershipForUser(user.id) : null;
    const workspaceId = membership?.workspaceId ?? (await getDefaultWorkspace())?.id;
    if (!workspaceId) return;

    await recordAudit({
      workspaceId,
      actorType: 'user',
      // An unknown account has no id; the attempted address is in the metadata.
      actorId: user?.id ?? 'unknown',
      action,
      target: 'login',
      metadata: { email: account, client: address, ...metadata },
    });
  } catch (error) {
    console.error('[auth] sign-in event could not be audited', error);
  }
}

export interface LoginInput {
  email: string;
  password: string;
  headers: Headers;
}

/**
 * One sign-in attempt. Returns only whether it succeeded: the caller answers a
 * refusal by the limiter and a wrong password identically.
 */
export async function attemptLogin(input: LoginInput): Promise<{ ok: boolean }> {
  const account = normalizeAccount(input.email);
  const address = resolveClientAddress(input.headers);
  const gate = consumeLoginAttempt(account, clientKey(input.headers));

  if (!gate.allowed) {
    const sample = getAuditSampler().sample(`login:${account}`);
    if (sample.write) {
      await auditLoginEvent('auth.login_rate_limited', account, address, {
        limited_by: gate.limitedBy,
        suppressed: sample.suppressed,
      });
    }
    return { ok: false };
  }

  let ok = false;
  try {
    const result = await auth.api.signInEmail({
      body: { email: input.email, password: input.password },
      // The request's own headers, so the session records the client address
      // and user agent the proxy reported rather than none at all.
      headers: input.headers,
    });
    ok = Boolean(result?.user);
  } catch {
    ok = false;
  }

  if (!ok) {
    await auditLoginEvent('auth.login_failed', account, address);
  }
  return { ok };
}
