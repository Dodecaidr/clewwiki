import 'server-only';

import {
  importFromConfluence,
  importFromMarkdownZip,
  importFromNotionZip,
  importFromPdf,
} from '@clewwiki/import';
import type { ImportLimits, ImportParseResult, PdfSplitMode } from '@clewwiki/import';

import { PageServiceError } from '../pages/errors';

/**
 * Turning what arrived on the request into a call on one of the four adapters.
 *
 * This is where the credential rule is enforced in code rather than by
 * convention: the Confluence e-mail and API token exist as fields of
 * `ConfluenceRequest`, they are handed to the adapter, and they go out of scope
 * when the request ends. Nothing on this path writes them anywhere — not to the
 * import row, not to the audit log, not to a log line. The `params` the adapter
 * returns is what gets stored, and it carries the site address and the space
 * key only.
 */

export type ImportRequest =
  | ConfluenceRequest
  | { source: 'notion'; zip: Uint8Array }
  | { source: 'markdown'; zip: Uint8Array }
  | { source: 'pdf'; pdf: Uint8Array; filename: string; split: PdfSplitMode };

export interface ConfluenceRequest {
  source: 'confluence';
  baseUrl: string;
  spaceKey: string;
  /** Used for this run and then dropped. Never stored. */
  email: string;
  /** Used for this run and then dropped. Never stored. */
  apiToken: string;
}

export function parseImport(
  request: ImportRequest,
): (limits: ImportLimits) => Promise<ImportParseResult> {
  return async (limits) => {
    switch (request.source) {
      case 'confluence':
        return importFromConfluence({
          credentials: {
            baseUrl: request.baseUrl,
            email: request.email,
            apiToken: request.apiToken,
          },
          spaceKey: request.spaceKey,
          limits,
        });
      case 'notion':
        return importFromNotionZip({ zip: request.zip, limits });
      case 'markdown':
        return importFromMarkdownZip({ zip: request.zip, limits });
      case 'pdf':
        return importFromPdf({
          pdf: request.pdf,
          documentTitle: request.filename,
          split: request.split,
          limits,
        });
    }
  };
}

/** Refuses an upload past the limit before any adapter is asked to read it. */
export function assertUploadSize(bytes: number, limits: ImportLimits): void {
  if (bytes === 0) {
    throw new PageServiceError('validation', 'The uploaded file is empty');
  }
  if (bytes > limits.uploadBytes) {
    throw new PageServiceError(
      'validation',
      `The upload is larger than the ${Math.round(limits.uploadBytes / (1024 * 1024))} MB limit`,
      { bytes, limit: limits.uploadBytes },
    );
  }
}
