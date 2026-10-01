import { z } from 'zod';
import { markdownTables, toCsv } from '@clewwiki/import/sheets';

import { apiError, serviceErrorResponse, validationError } from '@/lib/api-response';
import { requireSpace, requireWorkspace } from '@/lib/api-auth';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';
import { exportPage } from '@/lib/pages/export';
import { writeXlsx } from '@/lib/sheets/xlsx';
import { getPageById } from '@/lib/pages/service';
import { getSpaceById } from '@/lib/spaces/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });
const querySchema = z.object({
  format: z.enum(['md', 'html', 'xlsx', 'csv']).default('md'),
  /** For `csv`: which table of the page, counting from 1. */
  table: z.coerce.number().int().min(1).max(1000).default(1),
});

/**
 * Exports one page as Markdown or HTML.
 *
 * Both formats are rendered from the single row just read — no second service,
 * no network call at export time — so an export keeps working when everything
 * around it is unavailable. Mermaid fences survive into the HTML as
 * `<pre class="mermaid">` holding their source.
 *
 * `xlsx` and `csv` export the page's tables instead: every pipe table as a
 * sheet of a workbook, named after the heading above it, or one table — the
 * `table`-th — as CSV.
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

    const { format, table } = parsedQuery.data;
    if (format === 'xlsx' || format === 'csv') {
      const tables = markdownTables(page.body);
      if (tables.length === 0) return apiError(404, 'not_found', 'The page has no tables');
      const base = (page.path.split('/').pop() || 'page').replace(/[^A-Za-z0-9._-]/g, '-');
      if (format === 'csv') {
        const chosen = tables[table - 1];
        if (!chosen) return apiError(404, 'not_found', `The page has ${tables.length} tables`);
        // A byte-order mark, so Excel opens UTF-8 as UTF-8.
        return new Response(`\uFEFF${toCsv(chosen.rows)}`, {
          status: 200,
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${base}-${table}.csv"`,
            'Cache-Control': 'no-store',
            ...auth.headers,
          },
        });
      }
      const workbook = writeXlsx(tables.map((entry, index) => ({ name: entry.title ?? `Table ${index + 1}`, rows: entry.rows })));
      return new Response(Buffer.from(workbook), {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${base}.xlsx"`,
          'Cache-Control': 'no-store',
          ...auth.headers,
        },
      });
    }

    const space = await getSpaceById(auth.workspaceId, page.spaceId);
    const exported = await exportPage(page, format, space ?? undefined);

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
