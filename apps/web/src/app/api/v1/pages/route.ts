import { z } from 'zod';

import { apiCreated, apiError, apiJson, readJsonBody, serviceErrorResponse, validationError } from '@/lib/api-response';
import { requireSpace, requireWorkspace } from '@/lib/api-auth';
import { getStaleAnchorCounts } from '@/lib/anchors/service';
import { getActiveClaimsByPage } from '@/lib/claims/service';
import { authorizePagesRequest, READ_SCOPES, WRITE_SCOPES } from '@/lib/pages-api';
import { createPage, getPageById, getPageByPath, getPageTree } from '@/lib/pages/service';
import type { PageTreeNode } from '@/lib/pages/service';
import { toPageResource, toTreeResource } from '@/lib/pages/serialize';
import { resolveSpaceParam, visibleSpaces } from '@/lib/spaces/access';
import type { SpaceRecord } from '@/lib/spaces/service';

export const dynamic = 'force-dynamic';

const listQuerySchema = z.object({
  space: z.string().min(1).max(20).optional(),
  parent_id: z.uuid().optional(),
  path: z.string().min(1).max(512).optional(),
  kind: z.enum(['technical', 'human']).optional(),
  depth: z.coerce.number().int().min(1).max(5).default(2),
});

const createBodySchema = z.object({
  // Required: a page lives in exactly one space, and paths are unique per
  // space, so a page created without one would have nowhere to go.
  space: z.string().trim().min(1).max(20),
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
 * `space` names the space to list; without it the roots of every space the
 * caller can see are listed, each node carrying its space. `parent_id` lists
 * that page's children (its space is implied); `path` lists the page at that
 * path together with its children and needs `space`, because the same path
 * can exist once per space. `depth` bounds how far the nesting goes, so a large
 * space cannot be pulled through one request by accident.
 */
export async function GET(request: Request) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsed = listQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) return validationError(parsed.error);
  const { space: spaceKey, parent_id: parentId, path, kind, depth } = parsed.data;

  if (path && !spaceKey) {
    return apiError(400, 'validation', 'A path lookup needs a space: paths are unique per space', {
      fields: { space: ['Required when path is given'] },
    });
  }

  try {
    let targets: SpaceRecord[];
    if (spaceKey) {
      const resolved = await resolveSpaceParam(auth.identity, spaceKey);
      if (!resolved.ok) return resolved.response;
      targets = [resolved.space];
    } else if (parentId) {
      const parent = await getPageById(auth.workspaceId, parentId);
      if (!parent) return apiError(404, 'not_found', 'Page not found');
      const mismatch = requireWorkspace(auth.identity, parent.workspaceId);
      if (mismatch) return mismatch;
      const hidden = requireSpace(auth.identity, parent.spaceId);
      if (hidden) return apiError(404, 'not_found', 'Page not found');
      targets = (await visibleSpaces(auth.identity, { includeArchived: true })).filter(
        (space) => space.id === parent.spaceId,
      );
    } else {
      targets = await visibleSpaces(auth.identity);
    }

    const [claims, staleAnchors] = await Promise.all([
      getActiveClaimsByPage(auth.workspaceId),
      getStaleAnchorCounts(auth.workspaceId),
    ]);
    const claimed = new Set(claims.keys());

    const nodes = [];
    for (const space of targets) {
      // Every read is bounded by the caller's workspace and the space in the
      // query itself, so a page elsewhere is never selected at all.
      const tree = await getPageTree(auth.workspaceId, space.id);

      let selected: PageTreeNode[];
      if (path) {
        const page = await getPageByPath(auth.workspaceId, space.id, path);
        const node = page ? findNode(tree, page.id) : null;
        selected = node ? [node] : [];
      } else if (parentId) {
        const node = findNode(tree, parentId);
        if (!node) return apiError(404, 'not_found', 'Page not found');
        selected = node.children;
      } else {
        selected = tree;
      }

      const pruned = prune(selected, depth).filter((node) => !kind || node.kind === kind);
      nodes.push(...pruned.map((node) => toTreeResource(node, space, claimed, staleAnchors)));
    }

    return apiJson({ nodes }, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/** Creates a page in a space. Requires `pages:write` for an agent token. */
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
    const resolved = await resolveSpaceParam(auth.identity, parsed.data.space);
    if (!resolved.ok) return resolved.response;
    const { space } = resolved;

    const page = await createPage({
      workspaceId: auth.workspaceId,
      spaceId: space.id,
      actor: auth.actor,
      title: parsed.data.title,
      path: parsed.data.path,
      parentId: parsed.data.parent_id ?? null,
      kind: parsed.data.kind,
      body: parsed.data.body,
      summary: parsed.data.summary ?? null,
    });
    return apiCreated(
      toPageResource(page, space, { linkedPage: null, claim: null }),
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
