'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { EditorDialog } from './editor-dialog';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/field';
import { cn } from '@/lib/utils';

interface ConvertResult {
  markdown: string;
  sheets: Array<{ name: string; rows: number; columns: number }>;
  dropped_images: number;
}

type Source = 'file' | 'google';

/**
 * Brings a spreadsheet or a Google Doc into the page being edited: an Excel
 * workbook or CSV file, or a Google Sheets / Docs link shared with anyone who
 * has it. The server converts it to Markdown and keeps nothing; the result is
 * inserted where the cursor is, and saved with the page.
 */
export function ImportDialog({
  open,
  onCancel,
  onInsert,
}: {
  open: boolean;
  onCancel: () => void;
  onInsert: (markdown: string) => void;
}) {
  if (!open) return null;
  return <ImportDialogBody onCancel={onCancel} onInsert={onInsert} />;
}

function ImportDialogBody({ onCancel, onInsert }: { onCancel: () => void; onInsert: (markdown: string) => void }) {
  const t = useTranslations('sheetImport');
  const [source, setSource] = useState<Source>('file');
  const [link, setLink] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConvertResult | null>(null);

  const run = async (request: () => Promise<Response>) => {
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const response = await request();
      const body = (await response.json().catch(() => null)) as
        | (ConvertResult & { error?: { details?: { reason?: string } } })
        | null;
      if (!response.ok || !body || body.error) {
        const reason = body?.error?.details?.reason;
        setError(t(`error_${reason ?? 'generic'}` as 'error_generic'));
        return;
      }
      setResult(body);
    } catch {
      setError(t('error_generic'));
    } finally {
      setPending(false);
    }
  };

  const fromFile = (file: File) =>
    run(() =>
      fetch(`/api/v1/sheets/convert?name=${encodeURIComponent(file.name)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      }),
    );

  const fromLink = () =>
    run(() =>
      fetch('/api/v1/sheets/convert', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: link }),
      }),
    );

  return (
    <EditorDialog
      open
      size="lg"
      onClose={onCancel}
      title={t('title')}
      description={t('description')}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button size="sm" disabled={!result} onClick={() => result && onInsert(result.markdown)}>
            {t('insert')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 text-sm">
        <div role="tablist" className="inline-flex w-fit rounded-(--radius-base) border border-border p-0.5">
          {(['file', 'google'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={source === value}
              onClick={() => {
                setSource(value);
                setError(null);
                setResult(null);
              }}
              className={cn(
                'rounded-(--radius-base) px-3 py-1',
                source === value ? 'bg-secondary font-medium' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {value === 'file' ? t('tabFile') : t('tabGoogle')}
            </button>
          ))}
        </div>

        {source === 'file' ? (
          <Field label={t('fileLabel')} htmlFor="sheet-file" hint={t('fileHint')}>
            <input
              id="sheet-file"
              type="file"
              accept=".xlsx,.xlsm,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              disabled={pending}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void fromFile(file);
              }}
              className="text-sm"
            />
          </Field>
        ) : (
          <div className="grid gap-2">
            <Field label={t('linkLabel')} htmlFor="sheet-link" hint={t('linkHint')}>
              <Input
                id="sheet-link"
                type="url"
                value={link}
                placeholder="https://docs.google.com/spreadsheets/d/…"
                onChange={(event) => setLink(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    if (link.trim() !== '') void fromLink();
                  }
                }}
              />
            </Field>
            <div>
              <Button type="button" variant="outline" size="sm" disabled={pending || link.trim() === ''} onClick={() => void fromLink()}>
                {t('fetch')}
              </Button>
            </div>
          </div>
        )}

        {pending ? <p className="text-muted-foreground">{t('working')}</p> : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
        {result ? (
          <div className="grid gap-2">
            {result.sheets.length > 0 ? (
              <ul className="grid gap-0.5 text-xs text-muted-foreground">
                {result.sheets.map((sheet) => (
                  <li key={sheet.name}>
                    <span className="font-medium text-foreground">{sheet.name}</span> —{' '}
                    {t('sheetSize', { rows: sheet.rows, columns: sheet.columns })}
                  </li>
                ))}
              </ul>
            ) : null}
            {result.dropped_images > 0 ? (
              <Alert>{t('droppedImages', { count: result.dropped_images })}</Alert>
            ) : null}
            <pre className="max-h-72 overflow-auto rounded-(--radius-base) border border-border bg-muted p-3 font-mono text-xs">
              {result.markdown.length > 4000 ? `${result.markdown.slice(0, 4000)}\n…` : result.markdown}
            </pre>
          </div>
        ) : null}
      </div>
    </EditorDialog>
  );
}
