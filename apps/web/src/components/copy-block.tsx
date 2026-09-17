'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * A block of text with a Copy button.
 *
 * Falls back to selecting the text when the clipboard API is unavailable (an
 * instance served over plain HTTP from a non-local address is not a secure
 * context), so the reader can still copy it by hand.
 */
export function CopyBlock({
  code,
  label,
  className,
  wrap = false,
}: {
  code: string;
  label?: string;
  className?: string;
  wrap?: boolean;
}) {
  const t = useTranslations('common');
  const [copied, setCopied] = useState(false);
  const pre = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const selectText = () => {
    const node = pre.current;
    if (!node) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      selectText();
    }
  };

  return (
    <div className={cn('grid gap-1.5', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {label ? <span className="text-xs font-medium text-muted-foreground">{label}</span> : <span />}
        <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
          {copied ? t('copied') : t('copy')}
        </Button>
      </div>
      <pre
        ref={pre}
        className={cn(
          'overflow-x-auto rounded-(--radius-base) border border-border bg-muted px-3 py-2 font-mono text-xs leading-relaxed',
          wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
        )}
      >
        {code}
      </pre>
      <span aria-live="polite" className="sr-only">
        {copied ? t('copied') : ''}
      </span>
    </div>
  );
}
