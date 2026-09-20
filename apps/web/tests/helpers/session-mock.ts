/**
 * What a test puts in place of `@/lib/session`.
 *
 * The module has two ways in — the session, and the session of somebody who may
 * write — and a mock that answers only the first would make every content
 * action look unauthenticated. Both are built here from the one thing a test
 * supplies, with the same rule the real module applies: a viewer is nobody to
 * an action that writes.
 */
export function sessionModuleMock<T>(current: () => Promise<T> | T): {
  getSessionContext: () => Promise<T>;
  getWriterSession: () => Promise<T | null>;
} {
  return {
    getSessionContext: async () => current(),
    getWriterSession: async () => {
      const session = await current();
      // Tests describe a session as loosely as they need to; the role is all that is read here.
      const role = typeof session === 'object' && session !== null ? (session as { role?: unknown }).role : undefined;
      return session && role !== 'viewer' ? session : null;
    },
  };
}
