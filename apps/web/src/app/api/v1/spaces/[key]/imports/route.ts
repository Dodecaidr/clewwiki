import { z } from 'zod';

import {
  apiCreated,
  apiError,
  apiJson,
  readJsonBody,
  serviceErrorResponse,
  validationError,
} from '@/lib/api-response';
import { authorizeImportRequest } from '@/lib/imports/auth';
import { assertUploadSize, parseImport } from '@/lib/imports/parse';
import type { ImportRequest } from '@/lib/imports/parse';
import { toImportResource } from '@/lib/imports/serialize';
import { createImport, importLimits, listImports } from '@/lib/imports/service';
import { resolveSpaceParam } from '@/lib/spaces/access';
import { spaceKeyParamSchema } from '@/lib/spaces/keys';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ key: string }> };

/**
 * Starting an import.
 *
 * Two request shapes, because the sources differ in kind. Confluence is JSON:
 * an address, a space key and the credential the run uses and nobody stores.
 * The other three are files, so they arrive as `multipart/form-data` — the one
 * place in this API that is not JSON, with its own cross-origin check in
 * `lib/csrf`.
 *
 * Parsing happens inside the request. An import that takes a while is a request
 * that takes a while; what it must never be is a write, and it is not — the
 * result is rows in `import_items` and an import in `needs_review`.
 */

const confluenceSchema = z
  .object({
    source: z.literal('confluence'),
    base_url: z.string().min(1).max(2_000),
    space_key: z.string().min(1).max(255),
    email: z.string().min(3).max(320),
    api_token: z.string().min(1).max(4_000),
  })
  .strict();

const PDF_SPLITS = ['single', 'h1'] as const;

/** Lists the imports of a space, newest first. */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authorizeImportRequest(request);
  if (!auth.ok) return auth.response;

  const key = spaceKeyParamSchema.safeParse((await context.params).key);
  if (!key.success) return apiError(404, 'not_found', 'Space not found');

  try {
    const resolved = await resolveSpaceParam(auth.identity, key.data);
    if (!resolved.ok) return resolved.response;

    const found = await listImports(auth.workspaceId, { spaceId: resolved.space.id });
    return apiJson({
      space: { key: resolved.space.key, name: resolved.space.name },
      imports: found.map((record) => toImportResource(record, resolved.space.key)),
    });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const contentType = request.headers.get('content-type') ?? '';
  const upload = /^multipart\/form-data\s*(;|$)/i.test(contentType.trim());

  const auth = await authorizeImportRequest(request, { upload });
  if (!auth.ok) return auth.response;

  const key = spaceKeyParamSchema.safeParse((await context.params).key);
  if (!key.success) return apiError(404, 'not_found', 'Space not found');

  try {
    const resolved = await resolveSpaceParam(auth.identity, key.data);
    if (!resolved.ok) return resolved.response;

    const parsed = upload ? await readUpload(request) : await readJson(request);
    if ('response' in parsed) return parsed.response;

    const created = await createImport({
      workspaceId: auth.workspaceId,
      spaceId: resolved.space.id,
      spaceKey: resolved.space.key,
      actor: auth.actor,
      source: parsed.request.source,
      parse: parseImport(parsed.request),
    });

    return apiCreated(toImportResource(created, resolved.space.key));
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

type ReadResult = { request: ImportRequest } | { response: ReturnType<typeof apiError> };

async function readJson(request: Request): Promise<ReadResult> {
  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch {
    return { response: apiError(400, 'validation', 'Request body is not valid JSON') };
  }
  const parsed = confluenceSchema.safeParse(raw);
  if (!parsed.success) return { response: validationError(parsed.error) };

  return {
    request: {
      source: 'confluence',
      baseUrl: parsed.data.base_url,
      spaceKey: parsed.data.space_key,
      // Held for this request and handed straight to the adapter. Nothing on
      // the path from here writes either of them anywhere.
      email: parsed.data.email,
      apiToken: parsed.data.api_token,
    },
  };
}

async function readUpload(request: Request): Promise<ReadResult> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { response: apiError(400, 'validation', 'The upload could not be read') };
  }

  const source = form.get('source');
  const file = form.get('file');
  if (typeof source !== 'string' || !(file instanceof File)) {
    return { response: apiError(400, 'validation', 'An import needs a source and a file') };
  }

  const limits = importLimits();
  try {
    assertUploadSize(file.size, limits);
  } catch (error) {
    return { response: serviceErrorResponse(error) };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (source === 'notion') return { request: { source: 'notion', zip: bytes } };
  if (source === 'markdown') return { request: { source: 'markdown', zip: bytes } };
  if (source === 'pdf') {
    const requested = form.get('split');
    const split = PDF_SPLITS.find((value) => value === requested) ?? 'single';
    return {
      request: {
        source: 'pdf',
        pdf: bytes,
        filename: file.name === '' ? 'Imported document' : file.name,
        split,
      },
    };
  }
  return { response: apiError(400, 'validation', `Unknown import source: ${source}`) };
}
