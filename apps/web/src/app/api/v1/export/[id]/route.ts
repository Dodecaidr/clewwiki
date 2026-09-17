import { z } from 'zod';

import { apiError, serviceErrorResponse, validationError } from '@/lib/api-response';
import { requireSpace, requireWorkspace } from '@/lib/api-auth';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';
import { exportPage } from '@/lib/pages/export';
import { getPageById } from '@/lib/pages/service';
import { getSpaceById } from '@/lib/spaces/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });
const querySchema = z.object({ format: z.enum(['md', 'html']).default('md') });

/**
 * Exports one page as Markdown or HTML.
 *
 * Both formats are rendered from the single row just read — no second service,
 * no network call at export time — so an export keeps working when everything
 * around it is unavailable. Mermaid fences survive into the HTML as
 * `<pre class="mermaid">` holding their source.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return apiError(404, 'not_found', 'Page not found');

  const parsedQuery = querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsedQuery.success) return validationError(parsedQuery.error);

  try {
    const page = await getPageById(auth.workspaceId, parsedParams.data.id);
    if (!page) return apiError(404, 'not_found', 'Page not found');

    const mismatch = requireWorkspace(auth.identity, page.workspaceId);
    if (mismatch) return mismatch;
    const hidden = requireSpace(auth.identity, page.spaceId);
    if (hidden) return apiError(404, 'not_found', 'Page not found');

    const space = await getSpaceById(auth.workspaceId, page.spaceId);
    const exported = await exportPage(page, parsedQuery.data.format, space ?? undefined);

    return new Response(exported.body, {
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
