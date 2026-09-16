import { z } from 'zod';

import { apiCreated, apiError, apiJson, readJsonBody, serviceErrorResponse, validationError } from '@/lib/api-response';
import { authorizePagesRequest, READ_SCOPES, WRITE_SCOPES } from '@/lib/pages-api';
import { createPage, getPageByPath, getPageTree } from '@/lib/pages/service';
import type { PageTreeNode } from '@/lib/pages/service';
import { toPageResource, toTreeResource } from '@/lib/pages/serialize';

export const dynamic = 'force-dynamic';

const listQuerySchema = z.object({
  parent_id: z.uuid().optional(),
  path: z.string().min(1).max(512).optional(),
  kind: z.enum(['technical', 'human']).optional(),
  depth: z.coerce.number().int().min(1).max(5).default(2),
});

const createBodySchema = z.object({
  title: z.string().trim().min(1).max(300),
  path: z.string().min(1).max(512).optional(),
  parent_id: z.uuid().nullish(),
  kind: z.enum(['technical', 'human']).default('technical'),
  body: z.string().max(1_000_000).default(''),
  summary: z.string().max(2_000).nullish(),
});

/** Cuts a tree down to the requested depth before it is serialised. */
function prune(nodes: PageTreeNode[], depth: number): PageTreeNode[] {
  if (depth <= 0) return [];
  return nodes.map((node) => ({ ...node, children: prune(node.children, depth - 1) }));
}

function findNode(nodes: PageTreeNode[], id: string): PageTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = findNode(node.children, id);
    if (hit) return hit;
  }
  return null;
}

/**
 * The page tree, without bodies.
 *
 * `parent_id` lists that page's children; `path` lists the page at that path
 * together with its children; neither lists the roots. `depth` bounds how far
 * the nesting goes, so a large workspace cannot be pulled through one request
 * by accident.
 */
export async function GET(request: Request) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsed = listQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) return validationError(parsed.error);

  try {
    // Every read is bounded by the caller's workspace in the query itself, so
    // a page belonging to another workspace is not merely hidden from the
    // response — it is never selected.
    const tree = await getPageTree(auth.workspaceId);
    const { parent_id: parentId, path, kind, depth } = parsed.data;

    let nodes: PageTreeNode[];
    if (path) {
      const page = await getPageByPath(auth.workspaceId, path);
      const node = page ? findNode(tree, page.id) : null;
      nodes = node ? [node] : [];
    } else if (parentId) {
      const node = findNode(tree, parentId);
      if (!node) return apiError(404, 'not_found', 'Page not found');
      nodes = node.children;
    } else {
      nodes = tree;
    }

    const pruned = prune(nodes, depth).filter((node) => !kind || node.kind === kind);
    return apiJson({ nodes: pruned.map(toTreeResource) }, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/** Creates a page. Requires `pages:write` for an agent token. */
export async function POST(request: Request) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;

  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch {
    return apiError(400, 'validation', 'Request body is not valid JSON');
  }

  const parsed = createBodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  try {
    const page = await createPage({
      workspaceId: auth.workspaceId,
      actor: auth.actor,
      title: parsed.data.title,
      path: parsed.data.path,
      parentId: parsed.data.parent_id ?? null,
      kind: parsed.data.kind,
      body: parsed.data.body,
      summary: parsed.data.summary ?? null,
    });
    return apiCreated(toPageResource(page, { linkedPage: null }), auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
