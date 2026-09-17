'use client';

import { checkMermaidSource } from '@clewwiki/content/mermaid';
import { useEffect, useId, useState } from 'react';

/**
 * A Mermaid diagram drawn live in the editor.
 *
 * The library is imported on first use, the same way the page view loads it,
 * and runs with `securityLevel: 'strict'`: diagram text is page content, and
 * Mermaid sanitises the SVG it produces under that setting. Drawing waits for
 * a pause in typing, so a half-typed diagram does not flash errors.
 */

type PreviewState =
  | { status: 'idle' }
  | { status: 'rendering' }
  | { status: 'drawn'; svg: string }
  | { status: 'failed'; message: string };

let renderCount = 0;

export interface MermaidPreviewLabels {
  rendering: string;
  failed: (message: string) => string;
}

export function MermaidPreview({ source, labels }: { source: string; labels: MermaidPreviewLabels }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [state, setState] = useState<PreviewState>({ status: 'idle' });

  useEffect(() => {
    let cancelled = false;
    const structural = checkMermaidSource(source);
    const timer = setTimeout(() => {
      if (structural[0]) {
        setState({ status: 'failed', message: structural[0].message });
        return;
      }
      setState((previous) => (previous.status === 'drawn' ? previous : { status: 'rendering' }));
      void (async () => {
        try {
          const { default: mermaid } = await import('mermaid');
          const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: prefersDark ? 'dark' : 'default',
            fontFamily: 'inherit',
          });
          await mermaid.parse(source);
          renderCount += 1;
          const { svg } = await mermaid.render(`mermaid-preview-${id}-${renderCount}`, source);
          if (!cancelled) setState({ status: 'drawn', svg });
        } catch (error) {
          if (!cancelled) {
            setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) });
          }
        }
      })();
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [source, id]);

  if (state.status === 'failed') {
    return (
      <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
        {labels.failed(state.message.slice(0, 600))}
      </p>
    );
  }
  if (state.status !== 'drawn') {
    return <p className="text-sm text-muted-foreground">{labels.rendering}</p>;
  }
  return (
    <div
      className="mermaid-preview flex justify-center overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full"
      // Produced by Mermaid under securityLevel "strict", which sanitises the
      // SVG before returning it; nothing from the page is inserted any other way.
      dangerouslySetInnerHTML={{ __html: state.svg }}
    />
  );
}
