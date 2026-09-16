/**
 * The page service, gathered behind one import.
 *
 * REST handlers, server components and — from Phase 5 — the MCP wrapper all
 * enter here, which is what keeps the authorization and audit rules from
 * existing in three slightly different versions.
 */
export * from './content';
export * from './errors';
export * from './export';
export * from './markdown';
export * from './paths';
export * from './serialize';
export * from './service';
