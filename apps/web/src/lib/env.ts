/**
 * Every value here comes from the process environment. Nothing is defaulted to
 * a real secret: a missing secret is a startup error, not a fallback.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }
  return parsed;
}

export function getDatabaseUrl(): string {
  return required('DATABASE_URL');
}

export function getAuthSecret(): string {
  return required('BETTER_AUTH_SECRET');
}

export function getAuthBaseUrl(): string {
  return process.env.BETTER_AUTH_URL ?? process.env.APP_BASE_URL ?? 'http://localhost:3000';
}

export function getAppBaseUrl(): string {
  return process.env.APP_BASE_URL ?? getAuthBaseUrl();
}

/** Requests per window allowed for a single agent token. */
export function getAgentRateLimitMax(): number {
  return optionalNumber('AGENT_TOKEN_RATE_LIMIT_MAX', 60);
}

/** Length of the agent-token rate limit window, in seconds. */
export function getAgentRateLimitWindowSeconds(): number {
  return optionalNumber('AGENT_TOKEN_RATE_LIMIT_WINDOW', 60);
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}
