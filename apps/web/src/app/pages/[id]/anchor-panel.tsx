'use client';

import { useActionState } from 'react';

import {
  checkAnchorsAction,
  confirmAnchorAction,
  createAnchorAction,
  deleteAnchorAction,
} from '../anchor-actions';
import type { AnchorActionState } from '../anchor-actions';
import { Alert, Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { cn } from '@/lib/utils';

/**
 * The anchors panel.
 *
 * Three states are shown three ways rather than as one badge: `stale` is a
 * diff to read, `moved-renamed` says where the declaration went, and `lost`
 * says a decision is needed. Collapsing them would be the quickest way to make
 * the whole mechanism ignorable.
 *
 * Everything the panel shows about the repository — a path, a symbol, a line
 * number — is displayed as text. Nothing here is a link that would fetch it,
 * and nothing is rendered as markup.
 */

const initialState: AnchorActionState = {};

export interface AnchorPanelItem {
  anchorId: string;
  state: 'fresh' | 'stale' | 'moved-renamed' | 'lost';
  kind: string;
  qualifiedName: string;
  fileHint: string;
  sectionId: string | null;
  fallback: boolean;
  lineStart: number | null;
  lineEnd: number | null;
  /** One ready-made sentence about what the last check found. */
  detailLabel: string | null;
  lastCheckedLabel: string | null;
}

export interface AnchorPanelLabels {
  heading: string;
  empty: string;
  noRepository: string;
  checkNow: string;
  confirm: string;
  remove: string;
  addHeading: string;
  fileLabel: string;
  fileHint: string;
  targetLabel: string;
  targetHint: string;
  sectionLabel: string;
  sectionHint: string;
  add: string;
  wholePage: string;
  sectionPrefix: string;
  fallbackLabel: string;
  fallbackShare: string;
  lastChecked: string;
  errorGeneric: string;
  states: Record<AnchorPanelItem['state'], string>;
}

const stateClasses: Record<AnchorPanelItem['state'], string> = {
  fresh: 'border-success/40 bg-success/10 text-foreground',
  stale: 'border-destructive/40 bg-destructive/10 text-foreground',
  'moved-renamed': 'border-border bg-muted text-foreground',
  lost: 'border-destructive/60 bg-destructive/15 text-foreground',
};

function StateBadge({ state, label }: { state: AnchorPanelItem['state']; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-(--radius-base) border px-2 py-0.5 text-xs font-medium',
        stateClasses[state],
      )}
    >
      {label}
    </span>
  );
}

function AnchorRow({
  anchor,
  labels,
  canConfirm,
}: {
  anchor: AnchorPanelItem;
  labels: AnchorPanelLabels;
  canConfirm: boolean;
}) {
  const [confirmState, confirmAction, confirming] = useActionState(
    confirmAnchorAction,
    initialState,
  );
  const [removeState, removeAction, removing] = useActionState(deleteAnchorAction, initialState);
  const failure = confirmState.error ?? removeState.error;

  return (
    <li className="grid gap-2 rounded-(--radius-base) border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-0.5">
          <p className="font-mono text-sm break-all">
            {anchor.kind} {anchor.qualifiedName}
          </p>
          <p className="font-mono text-xs break-all text-muted-foreground">
            {anchor.fileHint}
            {anchor.lineStart !== null && anchor.lineEnd !== null
              ? `:${anchor.lineStart}-${anchor.lineEnd}`
              : ''}
          </p>
          <p className="text-xs text-muted-foreground">
            {anchor.sectionId
              ? `${labels.sectionPrefix} ${anchor.sectionId}`
              : labels.wholePage}
            {anchor.fallback ? ` · ${labels.fallbackLabel}` : ''}
            {anchor.lastCheckedLabel ? ` · ${anchor.lastCheckedLabel}` : ''}
          </p>
        </div>
        <StateBadge state={anchor.state} label={labels.states[anchor.state]} />
      </div>

      {anchor.detailLabel ? (
        <p className="text-xs text-muted-foreground">{anchor.detailLabel}</p>
      ) : null}

      {failure ? (
        <p className="text-xs text-destructive">{labels.errorGeneric}</p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {canConfirm ? (
          <form action={confirmAction}>
            <input type="hidden" name="anchorId" value={anchor.anchorId} />
            <Button type="submit" variant="outline" size="sm" disabled={confirming}>
              {labels.confirm}
            </Button>
          </form>
        ) : null}
        <form action={removeAction}>
          <input type="hidden" name="anchorId" value={anchor.anchorId} />
          <Button type="submit" variant="ghost" size="sm" disabled={removing}>
            {labels.remove}
          </Button>
        </form>
      </div>
    </li>
  );
}

export function AnchorPanel({
  pageId,
  anchors,
  labels,
  hasRepository,
  fallbackShareLabel,
}: {
  pageId: string;
  anchors: AnchorPanelItem[];
  labels: AnchorPanelLabels;
  hasRepository: boolean;
  fallbackShareLabel: string | null;
}) {
  const [checkState, checkAction, checking] = useActionState(checkAnchorsAction, initialState);
  const [createState, createAction, creating] = useActionState(createAnchorAction, initialState);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>{labels.heading}</CardTitle>
        {hasRepository ? (
          <form action={checkAction}>
            <input type="hidden" name="pageId" value={pageId} />
            <Button type="submit" variant="outline" size="sm" disabled={checking}>
              {labels.checkNow}
            </Button>
          </form>
        ) : null}
      </CardHeader>
      <CardBody className="grid gap-4">
        {!hasRepository ? <Alert tone="info">{labels.noRepository}</Alert> : null}

        {checkState.error ? (
          <Alert tone="error">{checkState.message ?? labels.errorGeneric}</Alert>
        ) : null}

        {anchors.length === 0 ? (
          <p className="text-sm text-muted-foreground">{labels.empty}</p>
        ) : (
          <ul className="grid gap-2">
            {anchors.map((anchor) => (
              <AnchorRow
                key={anchor.anchorId}
                anchor={anchor}
                labels={labels}
                canConfirm={anchor.state === 'stale' || anchor.state === 'moved-renamed'}
              />
            ))}
          </ul>
        )}

        {fallbackShareLabel ? (
          <p className="text-xs text-muted-foreground">{fallbackShareLabel}</p>
        ) : null}

        {hasRepository ? (
          <form action={createAction} className="grid gap-3 border-t border-border pt-4">
            <h3 className="text-sm font-medium">{labels.addHeading}</h3>
            <input type="hidden" name="pageId" value={pageId} />
            <Field label={labels.fileLabel} htmlFor="anchor-file" hint={labels.fileHint}>
              <Input id="anchor-file" name="file" required maxLength={512} />
            </Field>
            <Field label={labels.targetLabel} htmlFor="anchor-target" hint={labels.targetHint}>
              <Input id="anchor-target" name="target" maxLength={500} />
            </Field>
            <Field label={labels.sectionLabel} htmlFor="anchor-section" hint={labels.sectionHint}>
              <Input id="anchor-section" name="sectionId" maxLength={200} />
            </Field>
            {createState.error ? (
              <Alert tone="error">{createState.message ?? labels.errorGeneric}</Alert>
            ) : null}
            <div>
              <Button type="submit" variant="secondary" size="sm" disabled={creating}>
                {labels.add}
              </Button>
            </div>
          </form>
        ) : null}
      </CardBody>
    </Card>
  );
}
