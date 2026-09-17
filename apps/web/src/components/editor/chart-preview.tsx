'use client';

import { buildChartTree, parseChartSource } from '@clewwiki/content/chart';
import type { ChartSvgNode, ContentIssue } from '@clewwiki/content/chart';
import { createElement } from 'react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * A chart drawn in the editor from its JSON, with the renderer the page view
 * and the export use. The SVG is built as React elements from the renderer's
 * element tree rather than injected as markup, so there is no HTML string to
 * sanitise on this side at all.
 */

function reactAttribute(name: string): string {
  if (name === 'class') return 'className';
  return name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function toReact(node: ChartSvgNode, key?: number): ReactNode {
  const props: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(node.attrs)) {
    if (value !== undefined) props[reactAttribute(name)] = value;
  }
  if (key !== undefined) props.key = key;
  return createElement(
    node.tag,
    props,
    ...node.children.map((child, index) => (typeof child === 'string' ? child : toReact(child, index))),
  );
}

export function ChartIssues({ errors, className }: { errors: ContentIssue[]; className?: string }) {
  return (
    <ul className={cn('grid list-disc gap-1 pl-5 text-sm', className)}>
      {errors.map((error, index) => (
        <li key={index}>
          {error.path ? <code className="font-mono text-xs">{error.path}</code> : null}
          {error.path ? ' — ' : null}
          {error.message}
        </li>
      ))}
    </ul>
  );
}

export function ChartPreview({ source, invalidLabel }: { source: string; invalidLabel: string }) {
  const result = parseChartSource(source);
  if (!result.ok) {
    return (
      <div className="chart-error" role="alert">
        <p className="font-medium">{invalidLabel}</p>
        <ChartIssues errors={result.errors} className="mt-1" />
      </div>
    );
  }
  return <div className="chart-block">{toReact(buildChartTree(result.spec))}</div>;
}
