/**
 * The MCP side of the one error vocabulary `docs/mcp.md` defines.
 *
 * The REST API spells its codes in lowercase because that is what its
 * endpoints have answered since Phase 1; the MCP boundary uppercases them, so
 * a tool result carries one of the codes below whatever REST condition
 * produced it. The mapping is a table rather than a `toUpperCase()` call on
 * purpose: several REST conditions collapse onto one MCP code, and a code the
 * table does not know must not be invented into the vocabulary by string
 * manipulation.
 */
export const MCP_ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'STALE_BASE',
  'RATE_LIMITED',
  'VALIDATION',
  'REPOSITORY_UNAVAILABLE',
  'INTERNAL',
] as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

/**
 * REST code → MCP code. Every lowercase code the REST layer can answer with is
 * listed; anything absent falls through to the status-code table below, and
 * anything that matches neither is `INTERNAL`.
 */
const CODE_MAP: Record<string, McpErrorCode> = {
  validation: 'VALIDATION',
  not_found: 'NOT_FOUND',
  conflict: 'CONFLICT',
  stale_base: 'STALE_BASE',
  forbidden: 'FORBIDDEN',
  insufficient_scope: 'FORBIDDEN',
  no_workspace: 'FORBIDDEN',
  unauthenticated: 'UNAUTHORIZED',
  invalid_token: 'UNAUTHORIZED',
  rate_limited: 'RATE_LIMITED',
  repository_unavailable: 'REPOSITORY_UNAVAILABLE',
  internal_error: 'INTERNAL',
};

const STATUS_MAP: Record<number, McpErrorCode> = {
  400: 'VALIDATION',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'VALIDATION',
  429: 'RATE_LIMITED',
  502: 'REPOSITORY_UNAVAILABLE',
};

/**
 * Maps one REST failure onto the MCP vocabulary.
 *
 * The code wins over the status when the REST layer named one, because two
 * conditions share `409` — a lease held by someone else (`conflict`) and a
 * write built on content that has moved on (`stale_base`) — and the caller's
 * next move is different for each.
 */
export function mapRestErrorCode(code: string | undefined, status: number): McpErrorCode {
  if (code) {
    const mapped = CODE_MAP[code];
    if (mapped) return mapped;
  }
  return STATUS_MAP[status] ?? 'INTERNAL';
}

/**
 * A failure on its way to a tool result.
 *
 * `details` is whatever the REST layer attached — the current content hash on a
 * stale write, the holder of a lease on a conflict — passed through unchanged,
 * because that is what makes the failure actionable rather than merely reported.
 */
export class ClewwikiToolError extends Error {
  readonly code: McpErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: McpErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ClewwikiToolError';
    this.code = code;
    this.details = details;
  }

  /** The envelope `docs/mcp.md` specifies, ready to be serialised into a result. */
  toEnvelope(): { error: { code: McpErrorCode; message: string; details?: Record<string, unknown> } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export function isClewwikiToolError(value: unknown): value is ClewwikiToolError {
  return value instanceof ClewwikiToolError;
}

interface RestErrorBody {
  error?: { code?: unknown; message?: unknown; details?: unknown };
}

/**
 * Turns a non-2xx REST response body into a tool error.
 *
 * A body that is not the REST envelope at all — an HTML error page from a
 * proxy, an empty 502 — still produces an error with a code taken from the
 * status, so a caller is never handed a bare transport failure it cannot
 * classify.
 */
export function toolErrorFromRest(status: number, body: unknown): ClewwikiToolError {
  const envelope = (typeof body === 'object' && body !== null ? (body as RestErrorBody).error : undefined) ?? {};
  const code = typeof envelope.code === 'string' ? envelope.code : undefined;
  const message =
    typeof envelope.message === 'string' && envelope.message.trim() !== ''
      ? envelope.message
      : `The clewwiki instance answered ${status}`;
  const details =
    typeof envelope.details === 'object' && envelope.details !== null
      ? (envelope.details as Record<string, unknown>)
      : undefined;

  return new ClewwikiToolError(mapRestErrorCode(code, status), message, details);
}
