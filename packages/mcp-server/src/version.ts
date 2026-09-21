/**
 * The published version of this package, as a plain constant.
 *
 * It is not read out of `package.json` at run time: the built entry point sits
 * one directory below the manifest, and a path that has to be right in the
 * source tree, in `dist`, and inside a bundler's output is three chances to
 * ship a server that cannot state its own version. `tests/version.test.ts`
 * asserts the constant and the manifest agree, so the duplication cannot drift.
 */
export const MCP_SERVER_VERSION = '0.6.0';

/** Sent on every REST call so an operator can tell tool traffic from the UI. */
export const USER_AGENT = `clewwiki-mcp/${MCP_SERVER_VERSION}`;
