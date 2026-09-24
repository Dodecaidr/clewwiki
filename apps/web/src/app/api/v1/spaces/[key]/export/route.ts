import { z } from 'zod';

import { apiError, serviceErrorResponse, validationError } from '@/lib/api-response';
import { requireWorkspace } from '@/lib/api-auth';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';
import { listPages } from '@/lib/pages/service';
import { resolveSpaceParam } from '@/lib/spaces/access';
import { listPageFiles, openFileVersion } from '@/lib/files/service';
import { filesEnabled } from '@/lib/files/store';
import { exportSpaceMarkdown, exportSpaceWithFiles } from '@/lib/spaces/export';
import { spaceKeyParamSchema } from '@/lib/spaces/keys';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  format: z.enum(['md']).default('md'),
  /** `latest` puts the latest version of every file beside its page. */
  files: z.enum(['none', 'latest']).default('none'),
});

/** Upper bound on pages in one archive. A larger space is refused, never truncated. */
const MAX_EXPORT_PAGES = 10_000;

/**
 * Exports a whole space as a ZIP of Markdown files whose folders mirror the
 * page tree (`KEY/backend.md`, `KEY/backend/auth.md`). Each file carries the
 * same front matter as the single-page export. `?files=latest` adds the latest
 * version of every file beside its page, streamed. `pages:read`; a space the
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
    if (parsedQuery.data.files === 'latest') {
      // Streamed: the files may be far larger than anything held in memory.
      const workspaceId = auth.workspaceId;
      const streamed = exportSpaceWithFiles(
        resolved.space,
        pages,
        (pageId) => listPageFiles(workspaceId, pageId),
        // With files switched off the bytes cannot be read; each file is then
        // listed as left out rather than failing the archive.
        (version) => (filesEnabled() ? openFileVersion(workspaceId, version) : Promise.resolve(null)),
      );
      return new Response(streamed.body, {
        status: 200,
        headers: {
          'Content-Type': streamed.contentType,
          'Content-Disposition': `attachment; filename="${streamed.filename}"`,
          'Cache-Control': 'no-store',
          ...auth.headers,
        },
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
