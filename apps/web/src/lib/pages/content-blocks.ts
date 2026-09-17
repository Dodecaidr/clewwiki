import { describeBlockIssue, validateContentBlocks } from '@clewwiki/content/blocks';
import type { BlockIssue } from '@clewwiki/content/blocks';

import { PageServiceError } from './errors';

/**
 * Structured blocks on write.
 *
 * Every chart block is validated against the chart schema and every Mermaid
 * block gets its structural check before a body is stored — for a browser
 * save and an agent write alike, because both reach the page service. The
 * refusal is a `validation` error whose details point at the block, so the
 * writer can fix exactly that block and try again.
 */

/** Blocks and errors per block carried in one refusal; the message names the first. */
const MAX_REPORTED_BLOCKS = 20;
const MAX_REPORTED_ERRORS = 20;

function capped(issue: BlockIssue): BlockIssue {
  return { ...issue, errors: issue.errors.slice(0, MAX_REPORTED_ERRORS) };
}

export function contentBlockErrorDetails(issues: BlockIssue[]): Record<string, unknown> | null {
  const [first] = issues;
  if (!first) return null;
  const head = capped(first);
  return {
    block_index: head.block_index,
    line: head.line,
    language: head.language,
    errors: head.errors,
    blocks: issues.slice(0, MAX_REPORTED_BLOCKS).map(capped),
  };
}

export function assertValidContentBlocks(body: string): void {
  const issues = validateContentBlocks(body);
  const details = contentBlockErrorDetails(issues);
  if (!details || !issues[0]) return;
  throw new PageServiceError('validation', describeBlockIssue(issues[0]), details);
}

/** Reads block issues back out of error details, for the editor to show them. */
export function blockIssuesFromDetails(details: Record<string, unknown> | undefined): BlockIssue[] {
  const blocks = details?.blocks;
  if (!Array.isArray(blocks)) return [];
  return blocks.filter(
    (block): block is BlockIssue =>
      typeof block === 'object' &&
      block !== null &&
      typeof (block as BlockIssue).block_index === 'number' &&
      typeof (block as BlockIssue).line === 'number' &&
      Array.isArray((block as BlockIssue).errors),
  );
}
