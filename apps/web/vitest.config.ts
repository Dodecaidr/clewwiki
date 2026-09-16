import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests share one Postgres schema, so they must not race.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.join(rootDir, 'src'),
      // `server-only` throws by design outside a React Server Components
      // bundle. The guard still applies to every real build; here it would
      // only stop the tests from importing the code they exist to exercise.
      'server-only': path.join(rootDir, 'tests', 'stubs', 'server-only.ts'),
    },
  },
});
