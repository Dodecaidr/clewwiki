import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MCP_SERVER_VERSION, USER_AGENT } from '../src/version.ts';

describe('version', () => {
  it('matches the published manifest', () => {
    const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string };
    expect(MCP_SERVER_VERSION).toBe(manifest.version);
  });

  it('is what the REST layer sees in the user agent', () => {
    expect(USER_AGENT).toBe(`clewwiki-mcp/${MCP_SERVER_VERSION}`);
  });
});
