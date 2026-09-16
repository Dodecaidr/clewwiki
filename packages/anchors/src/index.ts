/**
 * `@clewwiki/anchors` — the doc↔code anchoring library.
 *
 * Deliberately free of any dependency on the web application, the database or
 * Next.js: it takes source text in and returns declarations, hashes and
 * resolution states. That is what makes the mechanism testable on fixtures
 * rather than only against a running instance, and what will let the MCP
 * server reuse it unchanged.
 *
 * It never executes the source it is given. Repository content is data.
 */
export * from './declarations';
export * from './languages';
export * from './line-range';
export * from './parser';
export * from './resolve';
export * from './tokens';
export * from './types';
