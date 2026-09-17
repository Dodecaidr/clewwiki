import type { ActorKind, PageKind } from '@clewwiki/db';

import { toAnchorResource } from '../anchors/serialize';
import type { AnchorResource } from '../anchors/serialize';
import type { AnchorRecord } from '../anchors/service';
import { toClaimResource } from '../claims/serialize';
import type { ClaimResource } from '../claims/serialize';
import type { ClaimRecord } from '../claims/service';
import type { SpaceRef } from '../spaces/service';
import type { PageRecord, PageTreeNode, SearchHit } from './service';

/**
 * Wire shapes.
 *
 * These are the objects `docs/mcp.md` describes, in snake_case, produced in
 * one place so that REST today and the MCP wrapper later cannot answer with
 * two different versions of the same resource.
 *
 * Page bodies travel with their provenance — who wrote them, when, and the
 * content hash — because a consumer has to be able to treat them as stored
 * content from a named author rather than as instructions.
 */

export interface ActorResource {
  type: ActorKind;
  id: string;
}

/** The space a page, a hit or a claim belongs to. */
export interface SpaceRefResource {
  key: string;
  name: string;
}

export function toSpaceRefResource(space: Pick<SpaceRef, 'key' | 'name'>): SpaceRefResource {
  return { key: space.key, name: space.name };
}

export interface PageResource {
  page_id: string;
  space: SpaceRefResource;
  parent_id: string | null;
  path: string;
  title: string;
  kind: PageKind;
  summary: string | null;
  content_hash: string;
  version: number;
  created_at: string;
  created_by: ActorResource;
  updated_at: string;
  updated_by: ActorResource;
  body?: string;
  linked_page?: PageResource | null;
  /**
   * The code this page is anchored to, with the state of each anchor as of its
   * last check. Always present; empty when nothing is anchored.
   */
  anchors: AnchorResource[];
  /**
   * The lease currently held on this page, when there is one. A reader sees it
   * before it writes, which is what turns a lost update into a wait.
   */
  claim?: ClaimResource | null;
}

export interface PageNodeResource {
  page_id: string;
  space: SpaceRefResource;
  parent_id: string | null;
  path: string;
  title: string;
  kind: PageKind;
  updated_at: string;
  has_children: boolean;
  /**
   * How many anchors on this page are not `fresh` — stale, moved-renamed and
   * lost together. One number, because a tree node has room for a badge and
   * not for three; the page itself breaks it down.
   */
  stale_anchor_count: number;
  /** True while someone holds a claim on this page or one of its sections. */
  claimed: boolean;
  children?: PageNodeResource[];
}

export interface SearchHitResource {
  page_id: string;
  space: SpaceRefResource;
  path: string;
  title: string;
  kind: PageKind;
  snippet: string;
  content_hash: string;
  updated_at: string;
}

export interface SerializePageOptions {
  includeBody?: boolean;
  linkedPage?: PageRecord | null;
  /** Pass `null` to state explicitly that the page is unclaimed. */
  claim?: ClaimRecord | null;
  anchors?: readonly AnchorRecord[];
}

/**
 * `space` is the page's own space. A linked page is serialised with the same
 * one: a pair never spans two spaces.
 */
export function toPageResource(
  page: PageRecord,
  space: Pick<SpaceRef, 'key' | 'name'>,
  options: SerializePageOptions = {},
): PageResource {
  const resource: PageResource = {
    page_id: page.id,
    space: toSpaceRefResource(space),
    parent_id: page.parentId,
    path: page.path,
    title: page.title,
    kind: page.kind,
    summary: page.summary,
    content_hash: page.contentHash,
    version: page.version,
    created_at: page.createdAt.toISOString(),
    created_by: { type: page.createdByType, id: page.createdById },
    updated_at: page.updatedAt.toISOString(),
    updated_by: { type: page.updatedByType, id: page.updatedById },
    anchors: (options.anchors ?? []).map(toAnchorResource),
  };

  if (options.includeBody !== false) {
    resource.body = page.body;
  }
  if (options.linkedPage !== undefined) {
    resource.linked_page = options.linkedPage
      ? toPageResource(options.linkedPage, space, { includeBody: false })
      : null;
  }
  if (options.claim !== undefined) {
    resource.claim = options.claim ? toClaimResource(options.claim) : null;
  }
  return resource;
}

export function toPageNodeResource(
  page: PageRecord,
  space: Pick<SpaceRef, 'key' | 'name'>,
  hasChildren: boolean,
  claimed = false,
  staleAnchorCount = 0,
): PageNodeResource {
  return {
    page_id: page.id,
    space: toSpaceRefResource(space),
    parent_id: page.parentId,
    path: page.path,
    title: page.title,
    kind: page.kind,
    updated_at: page.updatedAt.toISOString(),
    has_children: hasChildren,
    stale_anchor_count: staleAnchorCount,
    claimed,
  };
}

/**
 * `claimedPageIds` and `staleAnchorCounts` carry the workspace's live claims
 * and anchor states, each read once for the whole tree rather than once per
 * node.
 */
export function toTreeResource(
  node: PageTreeNode,
  space: Pick<SpaceRef, 'key' | 'name'>,
  claimedPageIds: ReadonlySet<string> = new Set(),
  staleAnchorCounts: ReadonlyMap<string, number> = new Map(),
): PageNodeResource {
  return {
    page_id: node.id,
    space: toSpaceRefResource(space),
    parent_id: node.parentId,
    path: node.path,
    title: node.title,
    kind: node.kind,
    updated_at: node.updatedAt.toISOString(),
    has_children: node.children.length > 0,
    stale_anchor_count: staleAnchorCounts.get(node.id) ?? 0,
    claimed: claimedPageIds.has(node.id),
    children: node.children.map((child) =>
      toTreeResource(child, space, claimedPageIds, staleAnchorCounts),
    ),
  };
}

export function toSearchHitResource(hit: SearchHit): SearchHitResource {
  return {
    page_id: hit.pageId,
    space: { key: hit.spaceKey, name: hit.spaceName },
    path: hit.path,
    title: hit.title,
    kind: hit.kind,
    snippet: hit.snippet,
    content_hash: hit.contentHash,
    updated_at: hit.updatedAt.toISOString(),
  };
}
