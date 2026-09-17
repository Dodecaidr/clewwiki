'use client';

import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

/**
 * A modal dialog for the editor, on the native `<dialog>` element: focus is
 * trapped and restored, Escape closes it and the page behind is inert, all by
 * the browser.
 *
 * It is rendered into `document.body` rather than where it is used. The editor
 * lives inside the page form, and a text field inside a form submits that form
 * when Enter is pressed — a chart label is not a reason to save the page.
 */
export function EditorDialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className={cn(
        'm-auto max-h-[92vh] w-[calc(100vw-2rem)] overflow-hidden rounded-(--radius-base) border border-border bg-card p-0 text-card-foreground shadow-lg',
        'backdrop:bg-black/50',
        size === 'lg' ? 'max-w-5xl' : 'max-w-xl',
      )}
    >
      {open ? (
        <div className="grid max-h-[92vh] grid-rows-[auto_1fr_auto]">
          <header className="grid gap-1 border-b border-border px-5 py-4">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
          </header>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer ? (
            <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
              {footer}
            </footer>
          ) : null}
        </div>
      ) : null}
    </dialog>,
    document.body,
  );
}
