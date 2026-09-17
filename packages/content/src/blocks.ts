import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { Code, Nodes, Root } from 'mdast';

import { CHART_LANGUAGE, parseChartSource } from './chart/schema';
import type { ContentIssue } from './chart/schema';
import { checkMermaidSource, MERMAID_LANGUAGE } from './mermaid';

/**
 * Finding and checking the structured blocks of a page body.
 *
 * The body is parsed with the same Markdown parser the page view renders with
 * (`remark-parse` with GitHub-flavoured extensions), so a fence the renderer
 * would draw as a chart is exactly a fence this module validates — including
 * one nested in a list or a quote — and text that only looks like a fence is
 * ignored by both.
 */

export type ContentBlockLanguage = typeof CHART_LANGUAGE | typeof MERMAID_LANGUAGE;

export interface ContentBlock {
  /** Zero-based position among the body's chart and mermaid blocks. */
  index: number;
  /** One-based line of the opening fence in the body. */
  line: number;
  language: ContentBlockLanguage;
  source: string;
}

/** One invalid block, in the shape the API reports it. */
export interface BlockIssue {
  block_index: number;
  line: number;
  language: ContentBlockLanguage;
  errors: ContentIssue[];
}

const parser = unified().use(remarkParse).use(remarkGfm).freeze();

function collect(node: Nodes, out: Code[]): void {
  if (node.type === 'code') {
    if (node.lang === CHART_LANGUAGE || node.lang === MERMAID_LANGUAGE) out.push(node);
    return;
  }
  if ('children' in node) {
    for (const child of node.children) collect(child, out);
  }
}

export function findContentBlocks(markdown: string): ContentBlock[] {
  const tree = parser.parse(markdown) as Root;
  const codes: Code[] = [];
  collect(tree, codes);
  return codes.map((code, index) => ({
    index,
    line: code.position?.start.line ?? 1,
    language: code.lang as ContentBlockLanguage,
    source: code.value,
  }));
}

/** Validates every chart and mermaid block; an empty list means the body is fine. */
export function validateContentBlocks(markdown: string): BlockIssue[] {
  const issues: BlockIssue[] = [];
  for (const block of findContentBlocks(markdown)) {
    const errors =
      block.language === CHART_LANGUAGE
        ? (() => {
            const result = parseChartSource(block.source);
            return result.ok ? [] : result.errors;
          })()
        : checkMermaidSource(block.source);
    if (errors.length > 0) {
      issues.push({ block_index: block.index, line: block.line, language: block.language, errors });
    }
  }
  return issues;
}

/** One sentence naming the block and its first problems, for error messages. */
export function describeBlockIssue(issue: BlockIssue): string {
  const kind = issue.language === CHART_LANGUAGE ? 'Chart' : 'Mermaid';
  const detail = issue.errors
    .slice(0, 3)
    .map((error) => (error.path ? `${error.path}: ${error.message}` : error.message))
    .join('; ');
  const more = issue.errors.length > 3 ? ` (and ${issue.errors.length - 3} more)` : '';
  return `${kind} block ${issue.block_index} at line ${issue.line} is not valid: ${detail}${more}`;
}
