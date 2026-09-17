import { buildFormatGuide } from '@clewwiki/content/guide';

import { apiJson } from '@/lib/api-response';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';

export const dynamic = 'force-dynamic';

/**
 * The page format reference: every Markdown construct the wiki renders, the
 * Mermaid keywords and templates, the chart block schema with its limits and an
 * example per type, and the shape of a validation refusal.
 *
 * It is served by the instance rather than shipped inside the MCP package, so
 * an agent always reads the rules of the server it is writing to — a newer or
 * older MCP client cannot describe limits this instance does not enforce. It
 * holds no workspace data, but it sits behind `pages:read` like the rest of the
 * reading surface: nothing on this API answers an anonymous caller.
 */
export async function GET(request: Request) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;
  return apiJson(buildFormatGuide(), auth.headers);
}
