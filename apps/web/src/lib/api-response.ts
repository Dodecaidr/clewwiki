import { NextResponse } from 'next/server';
import { z } from 'zod';

import { isPageServiceError } from './pages/errors';

/**
 * The one error envelope the REST API answers with:
 *
 *     { "error": { "code": "…", "message": "…", "details": { } } }
 *
 * `docs/mcp.md` lists the vocabulary — `VALIDATION`, `NOT_FOUND`, `CONFLICT`,
 * `STALE_BASE`, `FORBIDDEN`, `UNAUTHORIZED`, `RATE_LIMITED`. REST spells them
 * in lowercase, matching the codes the endpoints from the previous phase
 * already return; the MCP wrapper uppercases them at its boundary.
 */
export function apiError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(
    { error: { code, message, ...(details ? { details } : {}) } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

export function apiJson(body: unknown, headers?: Record<string, string>): NextResponse {
  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'no-store', ...headers },
  });
}

export function apiCreated(body: unknown, headers?: Record<string, string>): NextResponse {
  return NextResponse.json(body, {
    status: 201,
    headers: { 'Cache-Control': 'no-store', ...headers },
  });
}

export function validationError(error: z.ZodError): NextResponse {
  return apiError(400, 'validation', 'Request body or query is not valid', {
    fields: z.flattenError(error).fieldErrors,
  });
}

/**
 * Maps a failure from the page service onto the envelope.
 *
 * Anything that is not a known service error is answered as a plain 500 with
 * no detail: an unexpected error's message may quote content or SQL, and the
 * caller is not the right audience for either. It is re-thrown to the server
 * log first, where it belongs.
 */
export function serviceErrorResponse(error: unknown): NextResponse {
  if (isPageServiceError(error)) {
    return apiError(error.status, error.code, error.message, error.details);
  }
  console.error('[api] unhandled error', error);
  return apiError(500, 'internal_error', 'The request could not be completed');
}

/** Parses a JSON request body, answering `validation` rather than throwing. */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    const text = await request.text();
    return text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    throw new SyntaxError('Request body is not valid JSON');
  }
}
