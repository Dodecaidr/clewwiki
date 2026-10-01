import { z } from 'zod';

import { apiError, apiJson, readJsonBody, validationError } from '@/lib/api-response';
import { authorizePagesRequest, WRITE_SCOPES } from '@/lib/pages-api';
import { ConvertError, MAX_CONVERT_BYTES, convertFile, convertGoogleLink } from '@/lib/sheets/convert';
import type { Converted } from '@/lib/sheets/convert';

export const dynamic = 'force-dynamic';

/**
 * Turns a spreadsheet or a Google Doc into page Markdown, without saving
 * anything: the editor inserts the result where the cursor is, and the page is
 * saved the usual way. `PUT` with the file as the body (`?name=` carries its
 * name, which decides the format); `POST {"url"}` for a Google Sheets or
 * Google Docs link shared with anyone who has it.
 *
 * It needs `pages:write` — it exists to write pages, and it makes the server
 * download from Google on the caller's behalf.
 */

function answer(converted: Converted, headers?: Record<string, string>) {
  return apiJson(
    {
      markdown: converted.markdown,
      sheets: converted.sheets,
      dropped_images: converted.droppedImages,
    },
    headers,
  );
}

function refusal(error: unknown) {
  if (error instanceof ConvertError) {
    const status = error.code === 'tooLarge' ? 413 : error.code === 'unavailable' ? 502 : 422;
    return apiError(status, 'validation', error.message, { reason: error.code });
  }
  throw error;
}

export async function PUT(request: Request) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES, { body: 'file' });
  if (!auth.ok) return auth.response;
  const name = new URL(request.url).searchParams.get('name') ?? '';
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_CONVERT_BYTES) return refusal(new ConvertError('tooLarge'));
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_CONVERT_BYTES) return refusal(new ConvertError('tooLarge'));
  try {
    return answer(convertFile(name, bytes), auth.headers);
  } catch (error) {
    return refusal(error);
  }
}

const linkSchema = z.object({ url: z.string().min(1).max(2_000) }).strict();

export async function POST(request: Request) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof SyntaxError) return apiError(400, 'validation', error.message);
    throw error;
  }
  const parsed = linkSchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error);
  try {
    return answer(await convertGoogleLink(parsed.data.url), auth.headers);
  } catch (error) {
    return refusal(error);
  }
}
