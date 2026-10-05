import 'server-only';

import type { Workspace } from '@clewwiki/db';

import { isMerged, streamIssueKeys } from './service';
import type { ReleaseRecord, StreamRecord } from './service';
import type { DevelopmentOverview } from './service';

/** The REST and MCP shape of a stream. Branch subjects are commit text: data. */
export function streamResource(
  stream: StreamRecord,
  workspace: Pick<Workspace, 'settings'>,
  extra: { openProblems?: number; releaseName?: string | null } = {},
): Record<string, unknown> {
  return {
    stream_id: stream.id,
    title: stream.title,
    branch: stream.ref,
    state: stream.state,
    merged: isMerged(stream),
    goal: stream.goal,
    issue_keys: streamIssueKeys(stream, workspace),
    release_id: stream.releaseId,
    ...(extra.releaseName !== undefined ? { release: extra.releaseName } : {}),
    docs_page_id: stream.docsPageId,
    open_problems: extra.openProblems ?? 0,
    git: stream.branch
      ? {
          last_commit: stream.branch.commit,
          last_commit_at: stream.branch.committed_at || null,
          last_commit_subject: stream.branch.subject,
          ahead: stream.branch.ahead,
          behind: stream.branch.behind,
          merged: stream.branch.merged,
          present: stream.branch.present,
          default_branch: stream.branch.default_branch,
          synced_at: stream.branch.synced_at,
        }
      : null,
    updated_at: stream.updatedAt.toISOString(),
    merged_at: stream.mergedAt?.toISOString() ?? null,
  };
}

export function releaseResource(release: ReleaseRecord): Record<string, unknown> {
  return {
    release_id: release.id,
    name: release.name,
    state: release.state,
    due_on: release.dueOn,
    notes: release.notes,
    shipped_at: release.shippedAt?.toISOString() ?? null,
  };
}

export function overviewResource(
  overview: DevelopmentOverview,
  workspace: Pick<Workspace, 'settings'>,
  problems: Map<string, number>,
): Record<string, unknown> {
  const names = new Map(overview.releases.map((entry) => [entry.release.id, entry.release.name]));
  const one = (stream: StreamRecord) =>
    streamResource(stream, workspace, { openProblems: problems.get(stream.id) ?? 0, releaseName: stream.releaseId ? (names.get(stream.releaseId) ?? null) : null });
  return {
    releases: overview.releases.map((entry) => ({
      ...releaseResource(entry.release),
      streams: entry.streams.map(one),
      not_merged: entry.missing.map((stream) => stream.title),
    })),
    merged_without_release: overview.mergedUnreleased.map(one),
    in_progress_without_release: overview.unplanned.map(one),
  };
}
