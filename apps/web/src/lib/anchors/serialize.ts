import type { ActorKind, AnchorStateValue } from '@clewwiki/db';

import type { AnchorRecord, FallbackShare } from './service';

/**
 * Wire shape for anchors, in the snake_case `docs/mcp.md` describes.
 *
 * The contract names `anchor_id`, `kind`, `qualified_name`, `file_hint` and
 * `state`, and says responses may carry more. They carry more here on purpose:
 * a reader who is told a page is stale and not told which file, which symbol
 * and what happened to it has been given an alarm rather than information.
 */
export interface AnchorResource {
  anchor_id: string;
  page_id: string;
  section_id?: string;
  language: string;
  kind: string;
  qualified_name: string;
  container: string | null;
  file_hint: string;
  line_start: number | null;
  line_end: number | null;
  /** True when this is a line-range anchor rather than a declaration anchor. */
  fallback: boolean;
  state: AnchorStateValue;
  detail: Record<string, unknown> | null;
  last_checked_ref: string | null;
  last_checked_at: string | null;
  created_by: { type: ActorKind; id: string };
  created_at: string;
  updated_at: string;
}

export function toAnchorResource(anchor: AnchorRecord): AnchorResource {
  const resource: AnchorResource = {
    anchor_id: anchor.id,
    page_id: anchor.pageId,
    language: anchor.language,
    kind: anchor.kind,
    qualified_name: anchor.qualifiedName,
    container: anchor.container,
    file_hint: anchor.fileHint,
    line_start: anchor.lineStart,
    line_end: anchor.lineEnd,
    fallback: anchor.fallback,
    state: anchor.state,
    detail: anchor.detail,
    last_checked_ref: anchor.lastCheckedRef,
    last_checked_at: anchor.lastCheckedAt ? anchor.lastCheckedAt.toISOString() : null,
    created_by: { type: anchor.createdByType, id: anchor.createdById },
    created_at: anchor.createdAt.toISOString(),
    updated_at: anchor.updatedAt.toISOString(),
  };
  // Omitted rather than null when the anchor covers the whole page, the same
  // way a page-level claim omits its section.
  if (anchor.sectionId !== null) resource.section_id = anchor.sectionId;
  return resource;
}

export interface FallbackShareResource {
  total: number;
  fallback: number;
  /** Rounded to four places; a share, not a percentage. */
  share: number;
}

export function toFallbackShareResource(share: FallbackShare): FallbackShareResource {
  return {
    total: share.total,
    fallback: share.fallback,
    share: Math.round(share.share * 10_000) / 10_000,
  };
}
