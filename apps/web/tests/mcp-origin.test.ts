import { describe, expect, it } from 'vitest';

import { corsHeaders, decideOrigin } from '@/lib/mcp/origin';

describe('MCP origin decision', () => {
  it('lets a request with no Origin header through, because no browser sent it', () => {
    expect(decideOrigin(null, [])).toEqual({ allowed: true, origin: null });
    expect(decideOrigin('   ', [])).toEqual({ allowed: true, origin: null });
  });

  it('refuses every browser origin while the allowlist is empty', () => {
    expect(decideOrigin('https://evil.example', [])).toEqual({
      allowed: false,
      origin: 'https://evil.example',
    });
  });

  it('accepts only an exact allowlisted origin', () => {
    const allowlist = ['https://agents.example.com'];
    expect(decideOrigin('https://agents.example.com', allowlist).allowed).toBe(true);
    expect(decideOrigin('https://agents.example.com.evil.example', allowlist).allowed).toBe(false);
    expect(decideOrigin('http://agents.example.com', allowlist).allowed).toBe(false);
  });

  it('never answers with a wildcard CORS origin', () => {
    expect(corsHeaders(null)).toEqual({});
    const headers = corsHeaders('https://agents.example.com');
    expect(headers['Access-Control-Allow-Origin']).toBe('https://agents.example.com');
    expect(Object.values(headers)).not.toContain('*');
  });
});
