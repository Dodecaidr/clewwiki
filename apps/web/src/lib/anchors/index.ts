/**
 * The anchor service, gathered behind one import.
 *
 * REST handlers, server components and — from Phase 5 — the MCP wrapper all
 * enter here, so the resolution rules and the audit trail exist in one place
 * rather than in three slightly different versions.
 */
export * from './serialize';
export * from './service';
