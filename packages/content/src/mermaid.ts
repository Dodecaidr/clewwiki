import type { ContentIssue } from './chart/schema';

/**
 * Mermaid blocks.
 *
 * Diagrams are drawn in the reader's browser, never on the server: running a
 * diagram renderer server-side would mean a headless browser for every write.
 * What the server does check is cheap and structural — the diagram names a
 * type Mermaid knows — which catches the most common agent mistake (a fence
 * marked `mermaid` holding prose, or a misspelt keyword) without pretending to
 * be a parser.
 */

export const MERMAID_LANGUAGE = 'mermaid';

export interface MermaidTemplate {
  /** Stable identifier, used by the editor's template picker. */
  id: string;
  /** The keyword the diagram starts with. */
  keyword: string;
  /** Plain-English name, for guides and the editor's fallback label. */
  name: string;
  source: string;
}

/**
 * One starting point per diagram type the editor offers. The format guide
 * quotes these too, so an agent sees exactly what the picker inserts.
 */
export const MERMAID_TEMPLATES: readonly MermaidTemplate[] = [
  {
    id: 'flowchart',
    keyword: 'flowchart',
    name: 'Flowchart',
    source: 'flowchart LR\n  A[Request] --> B{Authenticated?}\n  B -->|yes| C[Handle request]\n  B -->|no| D[Reject with 401]',
  },
  {
    id: 'sequence',
    keyword: 'sequenceDiagram',
    name: 'Sequence diagram',
    source:
      'sequenceDiagram\n  participant A as Agent\n  participant S as Server\n  A->>S: claim(page)\n  S-->>A: claim_id\n  A->>S: write(page, claim_id)\n  S-->>A: content_hash',
  },
  {
    id: 'class',
    keyword: 'classDiagram',
    name: 'Class diagram',
    source:
      'classDiagram\n  class Page {\n    +String title\n    +String body\n    +write()\n  }\n  class Claim {\n    +Date expiresAt\n    +renew()\n  }\n  Page "1" --> "0..*" Claim',
  },
  {
    id: 'state',
    keyword: 'stateDiagram-v2',
    name: 'State diagram',
    source: 'stateDiagram-v2\n  [*] --> Fresh\n  Fresh --> Stale: code changed\n  Stale --> Fresh: confirmed\n  Stale --> Lost: declaration removed',
  },
  {
    id: 'er',
    keyword: 'erDiagram',
    name: 'Entity relationship diagram',
    source:
      'erDiagram\n  SPACE ||--o{ PAGE : contains\n  PAGE ||--o{ REVISION : keeps\n  PAGE ||--o{ CLAIM : "is held by"',
  },
  {
    id: 'gantt',
    keyword: 'gantt',
    name: 'Gantt chart',
    source:
      'gantt\n  title Release plan\n  dateFormat YYYY-MM-DD\n  section Build\n    Editor      :a1, 2026-01-05, 10d\n    Charts      :a2, after a1, 7d\n  section Ship\n    Release     :milestone, after a2, 0d',
  },
  {
    id: 'pie',
    keyword: 'pie',
    name: 'Pie chart',
    source: 'pie title Pages by kind\n  "Technical" : 64\n  "Human" : 36',
  },
  {
    id: 'xychart-line',
    keyword: 'xychart-beta',
    name: 'XY chart (line)',
    source:
      'xychart-beta\n  title "Weekly active users"\n  x-axis [W1, W2, W3, W4]\n  y-axis "Users" 0 --> 2000\n  line [1200, 1350, 1310, 1580]',
  },
  {
    id: 'xychart-bar',
    keyword: 'xychart-beta',
    name: 'XY chart (bar)',
    source:
      'xychart-beta\n  title "p95 latency"\n  x-axis [API, Worker, Search]\n  y-axis "ms" 0 --> 500\n  bar [180, 420, 260]',
  },
  {
    id: 'quadrant',
    keyword: 'quadrantChart',
    name: 'Quadrant chart',
    source:
      'quadrantChart\n  title Effort against impact\n  x-axis Low effort --> High effort\n  y-axis Low impact --> High impact\n  quadrant-1 Plan carefully\n  quadrant-2 Do first\n  quadrant-3 Maybe later\n  quadrant-4 Avoid\n  Search: [0.3, 0.8]\n  Export: [0.7, 0.4]',
  },
  {
    id: 'mindmap',
    keyword: 'mindmap',
    name: 'Mind map',
    source: 'mindmap\n  root((clewwiki))\n    Pages\n      Technical\n      Human\n    Claims\n    Anchors',
  },
  {
    id: 'timeline',
    keyword: 'timeline',
    name: 'Timeline',
    source: 'timeline\n  title Project history\n  2025 : Idea : First prototype\n  2026 : Spaces : Visual editor',
  },
];

/**
 * Every keyword a diagram may start with. It is broader than the templates:
 * a page may use any diagram type Mermaid draws, and the editor only has
 * templates for the common ones.
 */
export const MERMAID_KEYWORDS: readonly string[] = [
  'flowchart',
  'flowchart-elk',
  'graph',
  'sequenceDiagram',
  'classDiagram',
  'classDiagram-v2',
  'stateDiagram',
  'stateDiagram-v2',
  'erDiagram',
  'gantt',
  'pie',
  'xychart-beta',
  'xychart',
  'quadrantChart',
  'mindmap',
  'timeline',
  'journey',
  'gitGraph',
  'requirementDiagram',
  'C4Context',
  'C4Container',
  'C4Component',
  'C4Dynamic',
  'C4Deployment',
  'sankey-beta',
  'sankey',
  'block-beta',
  'block',
  'packet-beta',
  'packet',
  'kanban',
  'architecture-beta',
  'radar-beta',
  'treemap-beta',
  'treemap',
];

/** Largest diagram source accepted, in characters. */
export const MERMAID_MAX_SOURCE_LENGTH = 50_000;

/**
 * The first line that carries the diagram type, the way Mermaid finds it:
 * after an optional front-matter block, directives (`%%{init: …}%%`) and
 * comments (`%% …`).
 */
export function mermaidDiagramLine(source: string): string | null {
  const lines = source.split(/\r?\n/);
  let index = 0;
  while (index < lines.length && (lines[index] ?? '').trim() === '') index += 1;
  if ((lines[index] ?? '').trim() === '---') {
    index += 1;
    while (index < lines.length && (lines[index] ?? '').trim() !== '---') index += 1;
    index += 1;
  }
  for (; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (line === '' || line.startsWith('%%')) continue;
    return line;
  }
  return null;
}

/** The diagram keyword a source starts with, or null when there is none. */
export function mermaidKeywordOf(source: string): string | null {
  const line = mermaidDiagramLine(source);
  if (line === null) return null;
  const token = /^[A-Za-z0-9-]+/.exec(line)?.[0] ?? '';
  return MERMAID_KEYWORDS.includes(token) ? token : null;
}

/** A structural check only; the diagram itself is parsed by the reader's browser. */
export function checkMermaidSource(source: string): ContentIssue[] {
  if (source.length > MERMAID_MAX_SOURCE_LENGTH) {
    return [{ path: '', message: `the diagram is longer than ${MERMAID_MAX_SOURCE_LENGTH} characters` }];
  }
  const line = mermaidDiagramLine(source);
  if (line === null) {
    return [{ path: '', message: 'the mermaid block is empty; it must start with a diagram type such as flowchart' }];
  }
  if (mermaidKeywordOf(source) === null) {
    const token = /^\S+/.exec(line)?.[0] ?? line;
    return [
      {
        path: '',
        message: `unknown diagram type "${token.slice(0, 40)}"; the first line must start with one of: ${MERMAID_KEYWORDS.join(', ')}`,
      },
    ];
  }
  return [];
}
