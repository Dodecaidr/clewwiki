import { escapeHtml, renderMarkdown } from './markdown';
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
export function exportPageMarkdown(page: PageRecord): ExportedPage {
  const frontMatter = [
    '---',
    `title: ${yamlString(page.title)}`,
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

const EXPORT_STYLES = `
:root { color-scheme: light dark; }
body { margin: 0 auto; max-width: 46rem; padding: 2.5rem 1.25rem;
  font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
h1, h2, h3, h4 { line-height: 1.25; margin: 2rem 0 0.75rem; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
pre { overflow-x: auto; padding: 0.875rem 1rem; border: 1px solid #8884; border-radius: 6px; }
table { border-collapse: collapse; } td, th { border: 1px solid #8884; padding: 0.4rem 0.6rem; }
blockquote { margin: 1rem 0; padding-left: 1rem; border-left: 3px solid #8884; }
.page-meta { margin: 0 0 2rem; padding-bottom: 1rem; border-bottom: 1px solid #8884;
  font-size: 0.85rem; opacity: 0.75; }
img { max-width: 100%; }
`.trim();

/**
 * HTML export: a standalone document, server-rendered and sanitised.
 *
 * Mermaid fences are kept as `<pre class="mermaid">` holding their source. No
 * script is embedded to draw them — the file has to open from disk, offline,
 * with nothing fetched — so a diagram reads as its source text here while the
 * application renders it in the browser.
 */
export async function exportPageHtml(page: PageRecord): Promise<ExportedPage> {
  const rendered = await renderMarkdown(page.body);
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

export async function exportPage(page: PageRecord, format: ExportFormat): Promise<ExportedPage> {
  return format === 'md' ? exportPageMarkdown(page) : exportPageHtml(page);
}
