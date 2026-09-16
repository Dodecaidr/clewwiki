import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import type { Element, Nodes, Root } from 'hast';

/**
 * Markdown rendering.
 *
 * Page bodies are content written by people and agents, and are treated as
 * data throughout: the pipeline never executes anything it finds, and raw HTML
 * in a body is not passed through — `remark-rehype` drops it and
 * `rehype-sanitize` removes anything that survived. One renderer serves the
 * page view, the editor preview and the HTML export, so the three cannot drift.
 */

export const MERMAID_CLASS = 'mermaid';
const MERMAID_LANGUAGE_CLASS = 'language-mermaid';

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
      if (node.tagName !== 'pre') return;

      const code = node.children.find(
        (child): child is Element => child.type === 'element' && child.tagName === 'code',
      );
      if (!code || !classListOf(code).includes(MERMAID_LANGUAGE_CLASS)) return;

      node.properties = { className: [MERMAID_CLASS] };
      node.children = [{ type: 'text', value: textOf(code).replace(/\n$/, '') }];
    });
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  // `allowDangerousHtml` is deliberately absent: raw HTML written into a page
  // body is content, not markup, and never becomes part of the output tree.
  .use(remarkRehype)
  .use(rehypeSanitize, defaultSchema)
  .use(rehypeMermaid)
  .use(rehypeStringify)
  .freeze();

/** Renders a page body to sanitised HTML. */
export async function renderMarkdown(body: string): Promise<string> {
  const file = await processor.process(body);
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
