/**
 * What an import looks like over REST.
 *
 * Snake case, like every other resource here. The staged Markdown goes out with
 * its links already resolved to the paths they will land on, because that is
 * what a reviewer is deciding about — the placeholder form is an internal
 * detail of how the item is stored between the preview and the apply.
 */

import type { ImportItemRecord, ImportPreview, ImportRecord, PreviewItem } from './service';
import type { AppliedItem, ApplyImportResult } from './service';

export function toImportResource(record: ImportRecord, spaceKey: string): Record<string, unknown> {
  return {
    id: record.id,
    space: spaceKey,
    source: record.source,
    status: record.status,
    params: record.params,
    stats: record.stats,
    error: record.error,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
  };
}

export function toImportItemResource(item: ImportItemRecord | PreviewItem): Record<string, unknown> {
  const preview = 'preview' in item ? item.preview : item.markdown;
  return {
    id: item.id,
    source_id: item.sourceId,
    parent_source_id: item.parentSourceId,
    title: item.title,
    target_path: item.targetPath,
    decision: item.decision,
    ordering: item.ordering,
    warnings: item.warnings,
    markdown: preview,
    created_page_id: item.createdPageId,
    ...('conflictPageId' in item
      ? { conflict_page_id: item.conflictPageId, claimed_by: item.claimedBy }
      : {}),
  };
}

export function toImportPreviewResource(
  preview: ImportPreview,
  spaceKey: string,
): Record<string, unknown> {
  return {
    import: toImportResource(preview.import, spaceKey),
    counts: preview.counts,
    items: preview.items.map(toImportItemResource),
  };
}

function toAppliedResource(item: AppliedItem): Record<string, unknown> {
  return {
    id: item.itemId,
    title: item.title,
    target_path: item.targetPath,
    page_id: item.pageId,
    ...(item.images ? { images: item.images } : {}),
    ...(item.imagesFailed ? { images_failed: item.imagesFailed } : {}),
    ...(item.files ? { files: item.files } : {}),
    ...(item.filesFailed ? { files_failed: item.filesFailed } : {}),
    ...(item.skipped ? { skipped: item.skipped } : {}),
    ...(item.detail ? { detail: item.detail } : {}),
  };
}

export function toApplyResource(
  result: ApplyImportResult,
  spaceKey: string,
): Record<string, unknown> {
  return {
    import: toImportResource(result.import, spaceKey),
    created: result.created.map(toAppliedResource),
    skipped: result.skipped.map(toAppliedResource),
  };
}
