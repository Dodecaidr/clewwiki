import 'server-only';

import type { Workspace } from '@clewwiki/db';
import { getFormatter, getTranslations } from 'next-intl/server';

import { isMerged, streamIssueKeys } from '@/lib/development/service';
import type { ReleaseRecord, StreamRecord } from '@/lib/development/service';
import { getIssueSummaries } from '@/lib/trackers/service';
import { issueUrl, readTrackers, trackerForKey } from '@/lib/trackers/settings';
import { spaceStreamHref } from '@/lib/spaces/urls';
import { formatDateTime } from '@/lib/utils';

import type { StreamRowData, StreamRowLabels } from './stream-row';

/** Everything the rows of the development views need, read in bulk. */
export async function buildRows(
  workspace: Pick<Workspace, 'id' | 'settings'>,
  spaceKey: string,
  streams: StreamRecord[],
  releases: ReleaseRecord[],
  problems: Map<string, number>,
): Promise<{ rows: Map<string, StreamRowData>; labels: StreamRowLabels }> {
  const t = await getTranslations('development');
  const format = await getFormatter();
  const trackers = readTrackers(workspace);
  const keysByStream = new Map(streams.map((stream) => [stream.id, streamIssueKeys(stream, workspace)]));
  const allKeys = [...new Set([...keysByStream.values()].flat())];
  const summaries = allKeys.length > 0 ? await getIssueSummaries(workspace, allKeys) : new Map();
  const releaseNames = new Map(releases.map((release) => [release.id, release.name]));

  const rows = new Map<string, StreamRowData>();
  for (const stream of streams) {
    const branch = stream.branch;
    const committed = branch?.committed_at ? new Date(branch.committed_at) : null;
    rows.set(stream.id, {
      id: stream.id,
      href: spaceStreamHref(spaceKey, stream.id),
      title: stream.title,
      ref: stream.ref,
      state: stream.state,
      stateLabel: t(`state_${stream.state}`),
      merged: isMerged(stream),
      ahead: branch && branch.present ? branch.ahead : null,
      behind: branch && branch.present ? branch.behind : null,
      branchGone: branch?.present === false,
      lastCommitAt: committed && !Number.isNaN(committed.getTime()) ? t('lastCommit', { when: formatDateTime(format, committed) ?? '' }) : null,
      openProblems: problems.get(stream.id) ?? 0,
      issues: (keysByStream.get(stream.id) ?? []).map((key) => {
        const tracker = trackerForKey(trackers, key);
        return { key, url: tracker ? issueUrl(tracker, key) : null, issue: summaries.get(key) ?? null };
      }),
      releaseName: stream.releaseId ? (releaseNames.get(stream.releaseId) ?? null) : null,
    });
  }
  const labels: StreamRowLabels = {
    merged: t('merged'),
    notMerged: t('notMerged'),
    ahead: (count) => t('ahead', { count }),
    behind: (count) => t('behind', { count }),
    branchGone: t('branchGone'),
    problems: (count) => t('problems', { count }),
    noBranch: t('noBranch'),
  };
  return { rows, labels };
}
