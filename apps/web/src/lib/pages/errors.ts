/**
 * Failures the page service can produce, expressed once so that the REST
 * handlers, the server components and — from Phase 5 — the MCP wrapper all
 * report the same condition the same way.
 *
 * The codes are the REST spelling of the vocabulary in `docs/mcp.md`
 * (`VALIDATION`, `NOT_FOUND`, `CONFLICT`, `STALE_BASE`, `FORBIDDEN`). REST
 * answers in lowercase because that is what the endpoints shipped in the
 * previous phase already answer; the MCP layer uppercases them on the way out.
 */
export type PageErrorCode =
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'stale_base'
  | 'forbidden';

const STATUS_BY_CODE: Record<PageErrorCode, number> = {
  validation: 400,
  not_found: 404,
  conflict: 409,
  stale_base: 409,
  forbidden: 403,
};

export class PageServiceError extends Error {
  readonly code: PageErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: PageErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'PageServiceError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export function isPageServiceError(value: unknown): value is PageServiceError {
  return value instanceof PageServiceError;
}
