/**
 * `server-only` exists to make a build fail when server code is pulled into a
 * client bundle. Vitest is neither, so it is stubbed out here; the guard still
 * applies to every real build.
 */
export {};
