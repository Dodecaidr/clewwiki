import type { ActorKind, PageKind } from '@clewwiki/db';

import { toClaimResource } from '../claims/serialize';
import type { ClaimResource } from '../claims/serialize';
import type { ClaimRecord } from '../claims/service';
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

export interface PageResource {
  page_id: string;
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
  /** Always present, empty until Phase 4 ships anchoring. */
  anchors: never[];
  /**
   * The lease currently held on this page, when there is one. A reader sees it
   * before it writes, which is what turns a lost update into a wait.
   */
  claim?: ClaimResource | null;
}

export interface PageNodeResource {
  page_id: string;
  parent_id: string | null;
  path: string;
  title: string;
  kind: PageKind;
  updated_at: string;
  has_children: boolean;
  /** Reserved for Phase 4; no anchor can be stale before anchors exist. */
  stale_anchor_count: number;
  /** True while someone holds a claim on this page or one of its sections. */
  claimed: boolean;
  children?: PageNodeResource[];
}

export interface SearchHitResource {
  page_id: string;
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
}

export function toPageResource(
  page: PageRecord,
  options: SerializePageOptions = {},
): PageResource {
  const resource: PageResource = {
    page_id: page.id,
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
    anchors: [],
  };

  if (options.includeBody !== false) {
    resource.body = page.body;
  }
  if (options.linkedPage !== undefined) {
    resource.linked_page = options.linkedPage
      ? toPageResource(options.linkedPage, { includeBody: false })
      : null;
  }
  if (options.claim !== undefined) {
    resource.claim = options.claim ? toClaimResource(options.claim) : null;
  }
  return resource;
}

export function toPageNodeResource(
  page: PageRecord,
  hasChildren: boolean,
  claimed = false,
): PageNodeResource {
  return {
    page_id: page.id,
    parent_id: page.parentId,
    path: page.path,
    title: page.title,
    kind: page.kind,
    updated_at: page.updatedAt.toISOString(),
    has_children: hasChildren,
    stale_anchor_count: 0,
    claimed,
  };
}

/**
 * `claimedPageIds` carries the workspace's live claims, read once for the whole
 * tree rather than once per node.
 */
export function toTreeResource(
  node: PageTreeNode,
  claimedPageIds: ReadonlySet<string> = new Set(),
): PageNodeResource {
  return {
    page_id: node.id,
    parent_id: node.parentId,
    path: node.path,
    title: node.title,
    kind: node.kind,
    updated_at: node.updatedAt.toISOString(),
    has_children: node.children.length > 0,
    stale_anchor_count: 0,
    claimed: claimedPageIds.has(node.id),
    children: node.children.map((child) => toTreeResource(child, claimedPageIds)),
  };
}

export function toSearchHitResource(hit: SearchHit): SearchHitResource {
  return {
    page_id: hit.pageId,
    path: hit.path,
    title: hit.title,
    kind: hit.kind,
    snippet: hit.snippet,
    content_hash: hit.contentHash,
    updated_at: hit.updatedAt.toISOString(),
  };
}
