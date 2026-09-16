'use client';

import { useEffect, useRef } from 'react';

/**
 * A rendered page body.
 *
 * The HTML arrives already parsed and sanitised on the server — the same
 * renderer the HTML export uses — so nothing is parsed in the browser and the
 * markup is fixed before it gets here. What the client adds is Mermaid: the
 * library is a large dependency and is imported only once a page actually
 * contains a diagram.
 */
export function PageBody({ html }: { html: string }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = container.current;
    if (!root) return;

    const nodes = Array.from(root.querySelectorAll<HTMLElement>('pre.mermaid'));
    if (nodes.length === 0) return;

    let cancelled = false;

    void (async () => {
      const { default: mermaid } = await import('mermaid');
      if (cancelled) return;

      const prefersDark =
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches;

      mermaid.initialize({
        startOnLoad: false,
        // Diagram text is page content written by people and agents. `strict`
        // keeps the renderer from treating any of it as markup.
        securityLevel: 'strict',
        theme: prefersDark ? 'dark' : 'default',
        fontFamily: 'inherit',
      });

      try {
        await mermaid.run({ nodes });
      } catch {
        // A diagram that does not parse stays visible as its source, which is
        // more useful to whoever has to fix it than an empty box.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [html]);

  if (html.trim() === '') {
    return null;
  }

  return (
    <div
      ref={container}
      className="markdown-body"
      // Server-rendered through remark/rehype with rehype-sanitize; raw HTML in
      // the source body is never carried into this string.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
