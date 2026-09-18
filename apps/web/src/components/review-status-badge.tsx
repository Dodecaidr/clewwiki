import type { RevisionReviewStatus } from '@/lib/reviews/service';

const CLASSES: Record<RevisionReviewStatus, string> = {
  pending: 'border-warning text-foreground',
  accepted: 'border-success/60 text-muted-foreground',
  reverted: 'border-destructive/60 text-muted-foreground',
  edited: 'border-border text-muted-foreground',
  none: '',
};

/**
 * What became of a revision, as a word in a border. A person's own revision has
 * no status and renders nothing: there was never anything to review.
 */
export function ReviewStatusBadge({
  status,
  label,
}: {
  status: RevisionReviewStatus;
  label: string;
}) {
  if (status === 'none') return null;
  return (
    <span className={`rounded-(--radius-base) border px-2 py-0.5 text-xs ${CLASSES[status]}`}>
      {label}
    </span>
  );
}
