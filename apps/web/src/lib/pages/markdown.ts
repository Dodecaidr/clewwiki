import { CALLOUT_MARKER, CALLOUT_TITLES } from '@clewwiki/content/callouts';
import type { CalloutKind } from '@clewwiki/content/callouts';
import {
  buildChartTree,
  CHART_SVG_ATTRIBUTES,
  CHART_SVG_TAGS,
  parseChartSource,
} from '@clewwiki/content/chart';
import type { ChartSvgNode, ContentIssue } from '@clewwiki/content/chart';
import { find, svg } from 'property-information';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { Options as SanitizeSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import type { Element, ElementContent, Nodes, Properties, Root } from 'hast';

/**
 * Markdown rendering.
 *
 * Page bodies are content written by people and agents, and are treated as
 * data throughout: the pipeline never executes anything it finds, and raw HTML
 * in a body is not passed through — `remark-rehype` drops it and
 * `rehype-sanitize` removes anything that survived. One renderer serves the
 * page view, the editor preview and the HTML export, so the three cannot drift.
 *
 * Three block types get more than the default rendering:
 *
 * - ```` ```mermaid ```` fences become `<pre class="mermaid">` for the browser
 *   to draw, after sanitisation (as before);
 * - ```` ```chart ```` fences are validated and drawn as inline SVG on the
 *   server, *before* sanitisation, so the SVG passes through the sanitiser on
 *   an allowlist of exactly the elements and attributes the chart renderer
 *   emits — an invalid block becomes an error box naming the problem;
 * - blockquotes that open with a GitHub alert marker (`> [!WARNING]`) become
 *   styled callouts, after sanitisation, the way the Mermaid rewrite works.
 */

export const MERMAID_CLASS = 'mermaid';
const MERMAID_LANGUAGE_CLASS = 'language-mermaid';
const CHART_LANGUAGE_CLASS = 'language-chart';

export interface RenderLabels {
  /** Titles shown on callouts, by kind. English when not given. */
  callouts?: Partial<Record<CalloutKind, string>>;
  /** Heading of the box shown in place of an invalid chart. */
  chartInvalid?: string;
}

function classListOf(node: Element): string[] {
  const value: unknown = node.properties?.className;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  return [];
}

function textOf(node: Nodes): string {
  if (node.type === 'text') return node.value;
  if ('children' in node) {
    return node.children.map((child) => textOf(child)).join('');
  }
  return '';
}

function fencedCode(node: Element, languageClass: string): Element | null {
  if (node.tagName !== 'pre') return null;
  const code = node.children.find(
    (child): child is Element => child.type === 'element' && child.tagName === 'code',
  );
  return code && classListOf(code).includes(languageClass) ? code : null;
}

/**
 * Rewrites ```mermaid fences into `<pre class="mermaid">` holding the diagram
 * source verbatim, which is the element the client renderer looks for.
 *
 * It runs *after* sanitisation on purpose. The class is added by us rather
 * than carried over from the document, so no sanitiser allowance has to be
 * widened to let it through, and the block's content stays a text node.
 */
function rehypeMermaid() {
  return (tree: Root): void => {
    visit(tree, 'element', (node: Element) => {
      const code = fencedCode(node, MERMAID_LANGUAGE_CLASS);
      if (!code) return;
      node.properties = { className: [MERMAID_CLASS] };
      node.children = [{ type: 'text', value: textOf(code).replace(/\n$/, '') }];
    });
  };
}

/** The renderer's element tree as HTML syntax-tree nodes, property names resolved for SVG. */
export function chartTreeToHast(node: ChartSvgNode): Element {
  const properties: Properties = {};
  for (const [attribute, value] of Object.entries(node.attrs)) {
    if (value === undefined) continue;
    const { property } = find(svg, attribute);
    properties[property] = attribute === 'class' ? value.split(/\s+/) : value;
  }
  return {
    type: 'element',
    tagName: node.tag,
    properties,
    children: node.children.map(
      (child): ElementContent =>
        typeof child === 'string' ? { type: 'text', value: child } : chartTreeToHast(child),
    ),
  };
}

function chartErrorBox(errors: ContentIssue[], source: string, heading: string): Element {
  return {
    type: 'element',
    tagName: 'div',
    properties: { className: ['chart-error'] },
    children: [
      { type: 'element', tagName: 'p', properties: {}, children: [{ type: 'element', tagName: 'strong', properties: {}, children: [{ type: 'text', value: heading }] }] },
      {
        type: 'element',
        tagName: 'ul',
        properties: {},
        children: errors.map((error) => ({
          type: 'element',
          tagName: 'li',
          properties: {},
          children: [
            ...(error.path
              ? [
                  { type: 'element', tagName: 'code', properties: {}, children: [{ type: 'text', value: error.path }] } as Element,
                  { type: 'text', value: ' — ' } as const,
                ]
              : []),
            { type: 'text', value: error.message },
          ],
        })),
      },
      {
        type: 'element',
        tagName: 'pre',
        properties: {},
        children: [{ type: 'element', tagName: 'code', properties: {}, children: [{ type: 'text', value: source }] }],
      },
    ],
  };
}

/**
 * Draws ```chart fences as SVG. Runs before the sanitiser, so what it produces
 * is held to the same allowlist as everything else in the body.
 */
function rehypeCharts(labels: RenderLabels) {
  return (tree: Root): void => {
    visit(tree, 'element', (node: Element, index, parent) => {
      const code = fencedCode(node, CHART_LANGUAGE_CLASS);
      if (!code || !parent || index === undefined) return;
      const source = textOf(code).replace(/\n$/, '');
      const result = parseChartSource(source);
      const replacement: Element = result.ok
        ? {
            type: 'element',
            tagName: 'div',
            properties: { className: ['chart-block'] },
            children: [chartTreeToHast(buildChartTree(result.spec))],
          }
        : chartErrorBox(result.errors, source, labels.chartInvalid ?? 'This chart block is not valid');
      parent.children[index] = replacement;
    });
  };
}

/**
 * Turns `> [!KIND]` blockquotes into callouts. After sanitisation, like the
 * Mermaid rewrite: the classes are ours, not the document's.
 */
function rehypeCallouts(labels: RenderLabels) {
  return (tree: Root): void => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'blockquote') return;
      const first = node.children.find((child): child is Element => child.type === 'element');
      if (!first || first.tagName !== 'p') return;
      const lead = first.children[0];
      if (!lead || lead.type !== 'text') return;
      const match = CALLOUT_MARKER.exec(lead.value);
      if (!match?.[1]) return;

      const kind = match[1].toUpperCase() as CalloutKind;
      lead.value = lead.value.slice(match[0].length);
      if (lead.value === '') first.children.shift();
      if (first.children.length === 0) {
        node.children.splice(node.children.indexOf(first), 1);
      }

      node.tagName = 'div';
      node.properties = { className: ['callout', `callout-${kind.toLowerCase()}`] };
      node.children.unshift(
        { type: 'text', value: '\n' },
        {
          type: 'element',
          tagName: 'p',
          properties: { className: ['callout-title'] },
          children: [{ type: 'text', value: labels.callouts?.[kind] ?? CALLOUT_TITLES[kind] }],
        },
      );
    });
  };
}

/** What `renderMarkdown` is told about a body's blocks when asked to mark them. */
export interface BlockMarks {
  /** First line of each commentable block, in order — `splitParagraphs` of the same body. */
  startLines: readonly number[];
  /** Unresolved comment threads per block index. */
  openThreads?: ReadonlyMap<number, number>;
}

/**
 * Marks the elements a comment can be attached to with `data-block`, and those
 * that carry unresolved comments with `data-comments`.
 *
 * It runs after the sanitiser, so these two attributes exist only where this
 * function put them: nothing written into a page body can produce or forge one.
 * An element is matched to a block by the source line it starts on — positions
 * survive the whole pipeline — and an element the pipeline built from nothing,
 * such as a rendered chart, simply has no mark and cannot be commented on from
 * the rendered page.
 */
function rehypeBlockMarks() {
  return (tree: Root, file: { data: Record<string, unknown> }): void => {
    const marks = file.data.blockMarks as BlockMarks | undefined;
    if (!marks) return;
    const indexByLine = new Map(marks.startLines.map((line, index) => [line, index]));

    const mark = (node: ElementContent | Root['children'][number]): void => {
      if (node.type !== 'element') return;
      const line = node.position?.start.line;
      const index = line === undefined ? undefined : indexByLine.get(line);
      if (index === undefined) return;
      node.properties = { ...node.properties, dataBlock: String(index) };
      const open = marks.openThreads?.get(index) ?? 0;
      if (open > 0) node.properties.dataComments = String(open);
    };

    for (const node of tree.children) {
      if (node.type === 'element' && (node.tagName === 'ul' || node.tagName === 'ol')) {
        // A list is commented on item by item, as `splitParagraphs` splits it.
        for (const item of node.children) mark(item);
      } else {
        mark(node);
      }
    }
  };
}

const svgProperties = [...new Set(CHART_SVG_ATTRIBUTES.map((attribute) => find(svg, attribute).property))];

/**
 * The sanitiser schema: GitHub's defaults, plus exactly what the chart
 * renderer emits and nothing more. No SVG element that can carry a link, a
 * script, a style sheet, an animation or foreign content is on the list, and
 * no attribute that takes a URL or an event handler; `class` on chart
 * elements is limited to the renderer's own `chart…` names.
 */
export const sanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), ...CHART_SVG_TAGS],
  attributes: {
    ...defaultSchema.attributes,
    div: [
      ...(defaultSchema.attributes?.div ?? []),
      ['className', 'chart-block', 'chart-error'],
    ],
    ...Object.fromEntries(
      CHART_SVG_TAGS.map((tag) => [
        tag,
        svgProperties.map((property) =>
          property === 'className' ? (['className', /^chart(?:-[a-z0-9]+)*$/] as [string, RegExp]) : property,
        ),
      ]),
    ),
  },
};

function createProcessor(labels: RenderLabels) {
  return (
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      // `allowDangerousHtml` is deliberately absent: raw HTML written into a page
      // body is content, not markup, and never becomes part of the output tree.
      .use(remarkRehype)
      .use(rehypeCharts, labels)
      .use(rehypeSanitize, sanitizeSchema)
      .use(rehypeMermaid)
      .use(rehypeCallouts, labels)
      .use(rehypeBlockMarks)
      .use(rehypeStringify)
      .freeze()
  );
}

const processors = new Map<string, ReturnType<typeof createProcessor>>();

function processorFor(labels: RenderLabels) {
  const key = JSON.stringify(labels);
  let processor = processors.get(key);
  if (!processor) {
    processor = createProcessor(labels);
    // One per interface language in practice; the cap keeps a bug from
    // turning the cache into a leak.
    if (processors.size > 16) processors.clear();
    processors.set(key, processor);
  }
  return processor;
}

/**
 * Renders a page body to sanitised HTML. With `blockMarks`, the elements a
 * comment can be attached to are marked for the page view; every other caller —
 * the export, a preview, a skill — gets the same HTML as before.
 */
export async function renderMarkdown(
  body: string,
  labels: RenderLabels = {},
  blockMarks?: BlockMarks,
): Promise<string> {
  const file = await processorFor(labels).process(
    blockMarks ? { value: body, data: { blockMarks } } : body,
  );
  return String(file);
}

/** True when a body contains at least one Mermaid fence. */
export function containsMermaid(body: string): boolean {
  return /^[ \t]*```+[ \t]*mermaid\b/m.test(body);
}

/** Minimal HTML escaping, for the places a value is interpolated by hand. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
