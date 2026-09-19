import { CHART_PALETTE } from '@clewwiki/content/chart';

import { escapeHtml, renderMarkdown } from './markdown';
import { imageHref, referencedImageIds } from '../images/detect';
import { getImageData, listImagesForPage } from '../images/service';
import { lastSegment } from './paths';
import type { PageRecord } from './service';

/**
 * Export.
 *
 * Both formats are produced from the page that was just read — one database
 * round trip, no rendering service, nothing fetched at export time. That is a
 * constraint rather than an implementation detail: an export that needs a
 * second system is an export that stops working when that system does.
 */

export type ExportFormat = 'md' | 'html';

export interface ExportedPage {
  format: ExportFormat;
  filename: string;
  contentType: string;
  body: string;
}

/** Quotes a value as a YAML double-quoted scalar. */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

function baseFilename(page: PageRecord): string {
  try {
    return lastSegment(page.path);
  } catch {
    return 'page';
  }
}

/**
 * Markdown export: the body exactly as stored, under front matter carrying the
 * metadata a reader needs to put the file back where it came from. The body is
 * not reformatted — an export that rewrites content is not a copy of it.
 */
export function exportPageMarkdown(page: PageRecord, space?: { key: string }): ExportedPage {
  const frontMatter = [
    '---',
    `title: ${yamlString(page.title)}`,
    ...(space ? [`space: ${yamlString(space.key)}`] : []),
    `path: ${yamlString(page.path)}`,
    `kind: ${page.kind}`,
    `version: ${page.version}`,
    `content_hash: ${yamlString(page.contentHash)}`,
    `updated_at: ${yamlString(page.updatedAt.toISOString())}`,
    '---',
    '',
    '',
  ].join('\n');

  return {
    format: 'md',
    filename: `${baseFilename(page)}.md`,
    contentType: 'text/markdown; charset=utf-8',
    body: `${frontMatter}${page.body.endsWith('\n') ? page.body : `${page.body}\n`}`,
  };
}

const LIGHT_CHART_COLOURS = CHART_PALETTE.light.map((colour, index) => `--chart-${index + 1}: ${colour};`).join(' ');
const DARK_CHART_COLOURS = CHART_PALETTE.dark.map((colour, index) => `--chart-${index + 1}: ${colour};`).join(' ');
const CHART_CLASS_RULES = CHART_PALETTE.light
  .map((_, index) => `.chart .chart-fill-${index + 1} { fill: var(--chart-${index + 1}); } .chart .chart-stroke-${index + 1} { stroke: var(--chart-${index + 1}); }`)
  .join('\n');

const EXPORT_STYLES = `
:root { color-scheme: light dark; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --grid: #e1e0d9;
  --note: #2a78d6; --tip: #1a8a4c; --important: #7a5ad6; --warning: #b27a00; --caution: #d03b3b; ${LIGHT_CHART_COLOURS} }
@media (prefers-color-scheme: dark) {
  :root { --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --grid: #2c2c2a; ${DARK_CHART_COLOURS} }
}
body { margin: 0 auto; max-width: 46rem; padding: 2.5rem 1.25rem;
  font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
h1, h2, h3, h4 { line-height: 1.25; margin: 2rem 0 0.75rem; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
pre { overflow-x: auto; padding: 0.875rem 1rem; border: 1px solid #8884; border-radius: 6px; }
table { display: block; overflow-x: auto; border-collapse: collapse; } td, th { border: 1px solid #8884; padding: 0.4rem 0.6rem; }
blockquote { margin: 1rem 0; padding-left: 1rem; border-left: 3px solid #8884; }
.callout { --callout: var(--note); margin: 1rem 0; padding: 0.6rem 1rem; border-left: 3px solid var(--callout);
  background: color-mix(in srgb, var(--callout) 8%, transparent); border-radius: 0 6px 6px 0; }
.callout > p { margin: 0.4rem 0; }
.callout-title { font-weight: 600; }
.callout-tip { --callout: var(--tip); } .callout-important { --callout: var(--important); }
.callout-warning { --callout: var(--warning); } .callout-caution { --callout: var(--caution); }
.chart-block { margin: 1rem 0; overflow-x: auto; }
.chart { display: block; width: 100%; max-width: 44rem; height: auto; font-family: inherit; }
.chart .chart-surface { fill: var(--surface); } .chart .chart-title { fill: var(--ink); }
.chart .chart-tick, .chart .chart-label { fill: var(--ink-2); } .chart .chart-grid { stroke: var(--grid); }
.chart .chart-axis { stroke: var(--ink-2); stroke-opacity: 0.5; } .chart .chart-ring { stroke: var(--surface); }
${CHART_CLASS_RULES}
.chart-error { margin: 1rem 0; padding: 0.6rem 1rem; border: 1px solid #d03b3b88; border-radius: 6px; }
.page-meta { margin: 0 0 2rem; padding-bottom: 1rem; border-bottom: 1px solid #8884;
  font-size: 0.85rem; opacity: 0.75; }
img { max-width: 100%; }
@page { margin: 18mm 16mm; }
@media print {
  :root { color-scheme: light; --surface: #ffffff; --ink: #000000; --ink-2: #52514e; --grid: #e1e0d9; ${LIGHT_CHART_COLOURS} }
  body { max-width: none; padding: 0; color: #000; background: #fff; font-size: 11pt; line-height: 1.5; }
  a { color: inherit; text-decoration: underline; }
  pre { overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere; }
  table { display: table; }
  pre, blockquote, table, img, .callout, .chart-block { break-inside: avoid; }
  h1, h2, h3, h4 { break-after: avoid; }
  thead { display: table-header-group; }
  .page-meta { opacity: 1; color: #444; }
}
`.trim();

/** Most image bytes one exported document carries inline; past it, images stay as addresses. */
const MAX_INLINE_IMAGE_BYTES = 32 * 1024 * 1024;

/**
 * Puts the page's own uploaded images into the document as `data:` addresses.
 *
 * The export has to open from disk with nothing fetched, and an address on this
 * instance is a fetch — one that needs a session besides. Only images that
 * belong to this page are inlined: whoever may export the page may see those,
 * while an address pointing at another page's image proves nothing about it and
 * is left as the address it was.
 */
async function inlineOwnImages(page: PageRecord, html: string): Promise<string> {
  const wanted = new Set(referencedImageIds(html));
  if (wanted.size === 0) return html;

  const own = (await listImagesForPage(page.workspaceId, page.id)).filter((image) => wanted.has(image.id));
  let budget = MAX_INLINE_IMAGE_BYTES;
  let out = html;
  for (const image of own) {
    if (image.byteSize > budget) continue;
    const data = await getImageData(page.workspaceId, image.id);
    if (!data) continue;
    budget -= image.byteSize;
    const address = `data:${image.contentType};base64,${Buffer.from(data).toString('base64')}`;
    out = out.replaceAll(`src="${imageHref(image.id)}"`, `src="${address}"`);
  }
  return out;
}

/**
 * HTML export: a standalone document, server-rendered and sanitised.
 *
 * Chart blocks arrive as inline SVG from the same renderer the page view uses,
 * styled by the rules above, so they show — and print — with no script at all.
 * Callouts are plain styled blocks. Mermaid fences are kept as
 * `<pre class="mermaid">` holding their source: no script is embedded to draw
 * them — the file has to open from disk, offline, with nothing fetched — so a
 * diagram reads as its source text here, while the page view in the
 * application draws it. Printing the page view once its diagrams have drawn is
 * the way to get them on paper.
 */
export async function exportPageHtml(page: PageRecord): Promise<ExportedPage> {
  const rendered = await inlineOwnImages(page, await renderMarkdown(page.body));
  const title = escapeHtml(page.title);

  const document = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${EXPORT_STYLES}</style>
</head>
<body>
<h1>${title}</h1>
<p class="page-meta">${escapeHtml(page.path)} · ${escapeHtml(page.kind)} · version ${page.version} · updated ${escapeHtml(page.updatedAt.toISOString())}</p>
${rendered}
</body>
</html>
`;

  return {
    format: 'html',
    filename: `${baseFilename(page)}.html`,
    contentType: 'text/html; charset=utf-8',
    body: document,
  };
}

export async function exportPage(
  page: PageRecord,
  format: ExportFormat,
  space?: { key: string },
): Promise<ExportedPage> {
  return format === 'md' ? exportPageMarkdown(page, space) : exportPageHtml(page);
}
