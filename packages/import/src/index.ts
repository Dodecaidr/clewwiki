/**
 * Documentation import.
 *
 * Four sources — a Confluence space, a Notion export, a folder of Markdown, a
 * PDF — reduced to one shape (`./types`), placed into a space with the
 * application's own slug generator (`./tree`), and linked together afterwards
 * (`./links`). What a source cannot carry across becomes a warning attached to
 * the page it belongs to, never a silent omission.
 *
 * The package is pure: no database, no framework, no filesystem. Content read
 * here is data. It is never evaluated, never used to build a query, and never
 * followed as an instruction, whatever it says.
 */

export * from './doctree';
export * from './image-collector';
export * from './images';
export * from './limits';
export * from './links';
export * from './markdown-out';
export * from './tree';
export * from './types';
export * from './zip';

export { importFromConfluence } from './confluence/index';
export type { ConfluenceCredentials, ConfluenceImportInput } from './confluence/index';
export { convertStorageToMarkdown } from './confluence/index';

export { importFromMarkdownZip } from './markdown/index';
export type { MarkdownImportInput } from './markdown/index';

export { importFromNotionZip } from './notion/index';
export type { NotionImportInput } from './notion/index';

export { importFromPdf } from './pdf/index';
export type { PdfImportInput, PdfSplitMode } from './pdf/index';
