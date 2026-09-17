import { z } from 'zod';

import { apiError, serviceErrorResponse, validationError } from '@/lib/api-response';
import { requireWorkspace } from '@/lib/api-auth';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';
import { listPages } from '@/lib/pages/service';
import { resolveSpaceParam } from '@/lib/spaces/access';
import { exportSpaceMarkdown } from '@/lib/spaces/export';
import { spaceKeyParamSchema } from '@/lib/spaces/keys';

export const dynamic = 'force-dynamic';

const querySchema = z.object({ format: z.enum(['md']).default('md') });

/** Upper bound on pages in one archive. A larger space is refused, never truncated. */
const MAX_EXPORT_PAGES = 10_000;

/**
 * Exports a whole space as a ZIP of Markdown files whose folders mirror the
 * page tree (`KEY/backend.md`, `KEY/backend/auth.md`). Each file carries the
 * same front matter as the single-page export. `pages:read`; a space the
 * caller cannot see is `404`.
 */
export async function GET(request: Request, context: { params: Promise<{ key: string }> }) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const key = spaceKeyParamSchema.safeParse((await context.params).key);
  if (!key.success) return apiError(404, 'not_found', 'Space not found');

  const parsedQuery = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsedQuery.success) return validationError(parsedQuery.error);

  try {
    const resolved = await resolveSpaceParam(auth.identity, key.data);
    if (!resolved.ok) return resolved.response;
    const mismatch = requireWorkspace(auth.identity, resolved.space.workspaceId);
    if (mismatch) return mismatch;

    const pages = await listPages(auth.workspaceId, {
      spaceId: resolved.space.id,
      limit: MAX_EXPORT_PAGES + 1,
    });
    if (pages.length > MAX_EXPORT_PAGES) {
      return apiError(400, 'validation', 'This space has too many pages to export in one archive', {
        limit_pages: MAX_EXPORT_PAGES,
      });
    }
    const exported = exportSpaceMarkdown(resolved.space, pages);

    return new Response(Buffer.from(exported.body), {
      status: 200,
      headers: {
        'Content-Type': exported.contentType,
        'Content-Disposition': `attachment; filename="${exported.filename}"`,
        'Cache-Control': 'no-store',
        ...auth.headers,
      },
    });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
