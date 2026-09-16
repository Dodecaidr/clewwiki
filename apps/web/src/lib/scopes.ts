/**
 * Scope vocabulary for agent tokens.
 *
 * Scopes are plain `resource:action` strings. A granted scope may use `*` as
 * the action (`pages:*`) or as the whole string (`*`) to mean "everything";
 * a *required* scope is always concrete, so a caller can never widen its own
 * access by asking for a wildcard.
 */

export const AGENT_SCOPES = [
  'identity:read',
  'pages:read',
  'pages:write',
  'audit:read',
] as const;

export type AgentScope = (typeof AGENT_SCOPES)[number];

/** Scopes pre-selected in the token form; a narrower set is always allowed. */
export const DEFAULT_AGENT_SCOPES: AgentScope[] = ['identity:read', 'pages:read'];

export function isAgentScope(value: string): value is AgentScope {
  return (AGENT_SCOPES as readonly string[]).includes(value);
}

/**
 * Keeps only recognised scopes, de-duplicated and in the canonical order, so a
 * token can never be stored carrying a scope the server does not understand.
 */
export function normalizeScopes(values: readonly string[]): AgentScope[] {
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (isAgentScope(trimmed)) {
      seen.add(trimmed);
    }
  }
  return AGENT_SCOPES.filter((scope) => seen.has(scope));
}

/** True when `granted` covers the concrete scope `required`. */
export function hasScope(granted: readonly string[], required: string): boolean {
  if (required.includes('*')) {
    // A wildcard is only ever meaningful on the granting side.
    return false;
  }
  const [resource] = required.split(':');
  for (const scope of granted) {
    if (scope === '*' || scope === required) return true;
    if (resource && scope === `${resource}:*`) return true;
  }
  return false;
}

/** True when `granted` covers every one of `required`. */
export function hasAllScopes(granted: readonly string[], required: readonly string[]): boolean {
  return required.every((scope) => hasScope(granted, scope));
}
