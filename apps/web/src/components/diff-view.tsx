import type { DiffHunk, DiffLine, TextDiff } from '@clewwiki/content/diff';

import { cn } from '@/lib/utils';

export interface DiffViewLabels {
  /** Read out for the table as a whole. */
  caption: string;
  oldLine: string;
  newLine: string;
  added: string;
  removed: string;
  /** Between hunks: "N unchanged lines". */
  skipped: (count: number) => string;
  identical: string;
  onlyLineEndings: string;
  coarse: string;
}

const MARKER: Record<DiffLine['kind'], string> = { context: ' ', added: '+', removed: '−' };

function lineClass(kind: DiffLine['kind']): string {
  if (kind === 'added') return 'bg-success/10';
  if (kind === 'removed') return 'bg-destructive/10';
  return '';
}

/**
 * The text of one line. React escapes it: a line is page content and is shown
 * as the characters it is made of, never parsed as markup or Markdown — a diff
 * that rendered what it compares could not show what changed in the source.
 */
function LineText({ line }: { line: DiffLine }) {
  if (!line.segments) return <>{line.text === '' ? ' ' : line.text}</>;
  return (
    <>
      {line.segments.map((segment, index) =>
        segment.changed ? (
          <span
            key={index}
            className={cn(
              'rounded-xs',
              line.kind === 'added' ? 'bg-success/30' : 'bg-destructive/30',
            )}
          >
            {segment.text}
          </span>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

function skippedBefore(hunk: DiffHunk, previous: DiffHunk | undefined): number {
  const start = hunk.newLines > 0 ? hunk.newStart : hunk.newStart + 1;
  if (!previous) return Math.max(0, start - 1);
  const previousEnd =
    previous.newLines > 0 ? previous.newStart + previous.newLines - 1 : previous.newStart;
  return Math.max(0, start - previousEnd - 1);
}

/**
 * A unified diff as a table: old line number, new line number, marker, text.
 *
 * Colour is never the only signal — every changed row carries a `+` or `−` and
 * a label for screen readers — and the table scrolls sideways on its own, so a
 * long line does not widen the page.
 */
export function DiffView({ diff, labels }: { diff: TextDiff; labels: DiffViewLabels }) {
  if (diff.identical) return <p className="text-sm text-muted-foreground">{labels.identical}</p>;
  if (diff.onlyLineEndings) {
    return <p className="text-sm text-muted-foreground">{labels.onlyLineEndings}</p>;
  }

  return (
    <div className="grid gap-2">
      {diff.coarse ? <p className="text-xs text-muted-foreground">{labels.coarse}</p> : null}
      <div className="overflow-x-auto rounded-(--radius-base) border border-border">
        <table className="w-full border-collapse font-mono text-xs leading-5">
          <caption className="sr-only">{labels.caption}</caption>
          <thead className="sr-only">
            <tr>
              <th scope="col">{labels.oldLine}</th>
              <th scope="col">{labels.newLine}</th>
              <th scope="col" />
              <th scope="col" />
            </tr>
          </thead>
          {diff.hunks.map((hunk, hunkIndex) => {
            const skipped = skippedBefore(hunk, diff.hunks[hunkIndex - 1]);
            return (
              <tbody key={`${hunk.oldStart}-${hunk.newStart}`}>
                {skipped > 0 ? (
                  <tr className="border-y border-border bg-muted text-muted-foreground">
                    <td colSpan={4} className="px-3 py-0.5 font-sans">
                      {labels.skipped(skipped)}
                    </td>
                  </tr>
                ) : null}
                {hunk.lines.map((line, index) => (
                  <tr key={index} className={lineClass(line.kind)}>
                    <td className="w-10 select-none px-2 text-right tabular-nums text-muted-foreground">
                      {line.oldNumber ?? ''}
                    </td>
                    <td className="w-10 select-none px-2 text-right tabular-nums text-muted-foreground">
                      {line.newNumber ?? ''}
                    </td>
                    <td className="w-4 select-none text-center" aria-hidden>
                      {MARKER[line.kind]}
                    </td>
                    <td className="whitespace-pre-wrap break-words pr-3">
                      {line.kind === 'context' ? null : (
                        <span className="sr-only">
                          {line.kind === 'added' ? labels.added : labels.removed}:{' '}
                        </span>
                      )}
                      <LineText line={line} />
                    </td>
                  </tr>
                ))}
              </tbody>
            );
          })}
        </table>
      </div>
    </div>
  );
}
