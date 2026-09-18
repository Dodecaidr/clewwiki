'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Alert } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';

/**
 * The review screen: the tree an import would create, and the decisions a
 * person makes about it.
 *
 * Every row can be untricked, every target path can be edited, and every
 * warning the conversion produced is shown next to the page it belongs to. The
 * body is there too, behind a disclosure, because a reconstruction — a PDF
 * above all — is a claim about what the document said, and a reviewer has to be
 * able to check it before five hundred pages appear in their wiki.
 *
 * Each edit is its own `PATCH`, so a half-finished review survives a reload.
 */

export interface ReviewItem {
  id: string;
  sourceId: string;
  parentSourceId: string | null;
  title: string;
  targetPath: string;
  decision: 'create' | 'skip' | 'overwrite';
  warnings: Array<{ code: string; detail?: string }>;
  markdown: string;
  conflictPageId: string | null;
  claimedBy: string | null;
  depth: number;
}

export interface ImportReviewProps {
  importId: string;
  items: ReviewItem[];
  /** Where to go once the import has been applied. */
  resultHref: string;
}

export function ImportReview({ importId, items, resultHref }: ImportReviewProps) {
  const t = useTranslations('imports');
  const router = useRouter();
  const [rows, setRows] = useState(items);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const selected = rows.filter((row) => row.decision !== 'skip');

  async function patch(item: ReviewItem, body: Record<string, unknown>): Promise<void> {
    setError(null);
    const response = await fetch(`/api/v1/imports/${importId}/items/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const parsed: unknown = await response.json().catch(() => null);
      setError(messageOf(parsed) ?? t('errorGeneric'));
      return;
    }
    const updated: unknown = await response.json();
    setRows((current) =>
      current.map((row) =>
        row.id === item.id
          ? {
              ...row,
              decision: decisionOf(updated) ?? row.decision,
              targetPath: pathOf(updated) ?? row.targetPath,
            }
          : row,
      ),
    );
  }

  async function apply(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/imports/${importId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        const parsed: unknown = await response.json().catch(() => null);
        setError(messageOf(parsed) ?? t('errorGeneric'));
        return;
      }
      router.push(resultHref);
      router.refresh();
    } catch {
      setError(t('errorGeneric'));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-4">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <ul className="grid gap-2">
        {rows.map((row) => (
          <li
            key={row.id}
            className="rounded-(--radius-base) border border-border p-3"
            style={{ marginInlineStart: `${Math.min(row.depth, 6) * 16}px` }}
          >
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={row.decision !== 'skip'}
                  disabled={pending}
                  onChange={(event) =>
                    void patch(row, {
                      decision: event.target.checked
                        ? row.conflictPageId === null
                          ? 'create'
                          : 'overwrite'
                        : 'skip',
                    })
                  }
                />
                {row.title}
              </label>

              {row.conflictPageId === null ? null : (
                <span className="rounded bg-muted px-2 py-0.5 text-xs">{t('conflictBadge')}</span>
              )}
              {row.claimedBy === null ? null : (
                <span className="rounded bg-muted px-2 py-0.5 text-xs">
                  {t('claimedBadge', { holder: row.claimedBy })}
                </span>
              )}
              <button
                type="button"
                className="ml-auto text-xs underline underline-offset-2"
                onClick={() => setOpen(open === row.id ? null : row.id)}
              >
                {open === row.id ? t('hideBody') : t('showBody')}
              </button>
            </div>

            <div className="mt-2 grid gap-2">
              <Input
                aria-label={t('targetPath')}
                className="h-8 font-mono text-xs"
                defaultValue={row.targetPath}
                disabled={pending}
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  if (value !== '' && value !== row.targetPath) void patch(row, { target_path: value });
                }}
              />

              {row.warnings.length === 0 ? null : (
                <ul className="grid gap-1 text-xs text-muted-foreground">
                  {row.warnings.map((warning, index) => (
                    <li key={`${warning.code}-${index}`}>
                      {t(`warning_${warning.code}`)}
                      {warning.detail ? `: ${warning.detail}` : ''}
                    </li>
                  ))}
                </ul>
              )}

              {open === row.id ? (
                <pre className="max-h-80 overflow-auto rounded-(--radius-base) border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground">
                  {row.markdown === '' ? t('emptyBody') : row.markdown}
                </pre>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={pending || selected.length === 0} onClick={() => void apply()}>
          {pending ? t('applying') : t('applyCount', { count: selected.length })}
        </Button>
        <span className="text-sm text-muted-foreground">
          {t('skippedCount', { count: rows.length - selected.length })}
        </span>
      </div>
    </div>
  );
}

function messageOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: { message?: unknown } }).error;
  return typeof error?.message === 'string' ? error.message : null;
}

function decisionOf(body: unknown): ReviewItem['decision'] | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as { decision?: unknown }).decision;
  return value === 'create' || value === 'skip' || value === 'overwrite' ? value : null;
}

function pathOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as { target_path?: unknown }).target_path;
  return typeof value === 'string' ? value : null;
}
