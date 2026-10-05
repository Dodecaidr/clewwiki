import Link from 'next/link';

import type { TrackerIssue } from '@/lib/trackers/client';
import { cn } from '@/lib/utils';

export interface StreamRowData {
  id: string;
  href: string;
  title: string;
  ref: string | null;
  state: string;
  stateLabel: string;
  merged: boolean;
  ahead: number | null;
  behind: number | null;
  branchGone: boolean;
  lastCommitAt: string | null;
  openProblems: number;
  issues: Array<{ key: string; url: string | null; issue: TrackerIssue | null }>;
  releaseName: string | null;
}

export interface StreamRowLabels {
  merged: string;
  notMerged: string;
  ahead: (count: number) => string;
  behind: (count: number) => string;
  branchGone: string;
  problems: (count: number) => string;
  noBranch: string;
}

/** One line of development in a list: where its branch stands, its issues, its open problems. */
export function StreamRow({ row, labels, trailing }: { row: StreamRowData; labels: StreamRowLabels; trailing?: React.ReactNode }) {
  return (
    <li className="grid gap-1 rounded-(--radius-base) border border-border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          aria-hidden
          className={cn('inline-block size-2 shrink-0 rounded-full', row.merged ? 'bg-success' : row.state === 'dropped' ? 'bg-muted-foreground' : 'bg-warning')}
        />
        <Link href={row.href} className="font-medium hover:underline">
          {row.title}
        </Link>
        {row.ref && row.ref !== row.title ? <span className="font-mono text-xs text-muted-foreground">{row.ref}</span> : null}
        <span className="rounded-(--radius-base) border border-border px-1.5 text-xs text-muted-foreground">{row.stateLabel}</span>
        <span className={cn('text-xs', row.merged ? 'text-success' : 'text-warning')}>{row.merged ? labels.merged : labels.notMerged}</span>
        {row.releaseName ? <span className="text-xs text-muted-foreground">→ {row.releaseName}</span> : null}
        {trailing ? <span className="ml-auto">{trailing}</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {row.ref === null ? <span>{labels.noBranch}</span> : null}
        {row.branchGone ? <span className="text-destructive">{labels.branchGone}</span> : null}
        {row.ahead !== null && !row.merged ? <span>{labels.ahead(row.ahead)}</span> : null}
        {row.behind !== null && row.behind > 0 && !row.merged ? <span>{labels.behind(row.behind)}</span> : null}
        {row.lastCommitAt ? <span>{row.lastCommitAt}</span> : null}
        {row.openProblems > 0 ? <span className="text-warning">{labels.problems(row.openProblems)}</span> : null}
        {row.issues.map(({ key, url, issue }) => (
          <a
            key={key}
            href={url ?? undefined}
            rel="noopener noreferrer"
            title={issue ? `${issue.summary}${issue.status ? ` — ${issue.status}` : ''}` : undefined}
            className={cn('font-mono text-primary underline-offset-2 hover:underline', issue?.resolved && 'line-through opacity-70')}
          >
            {key}
            {issue?.status ? ` · ${issue.status}` : ''}
          </a>
        ))}
      </div>
    </li>
  );
}
