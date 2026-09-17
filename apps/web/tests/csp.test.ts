import { describe, expect, it } from 'vitest';

import { buildContentSecurityPolicy, externalImagesAllowed } from '@/lib/csp';

describe('content security policy', () => {
  const production = buildContentSecurityPolicy({ nonce: 'abc', isDev: false, allowExternalImages: false });

  it('keeps scripts on a nonce with no eval and no inline scripts in production', () => {
    expect(production).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(production).not.toContain('unsafe-eval');
    expect(production).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(production).toContain("object-src 'none'");
    expect(production).toContain("frame-ancestors 'none'");
  });

  it('loads images only from this origin unless the operator allows external ones', () => {
    expect(production).toContain("img-src 'self' data: blob:;");
    const widened = buildContentSecurityPolicy({ nonce: 'abc', isDev: false, allowExternalImages: true });
    expect(widened).toContain("img-src 'self' data: blob: https:;");
    expect(widened).not.toMatch(/img-src[^;]*\bhttp:/);
  });

  it('reads the operator switch from the environment, off by default', () => {
    expect(externalImagesAllowed({})).toBe(false);
    expect(externalImagesAllowed({ ALLOW_EXTERNAL_IMAGES: 'yes' })).toBe(false);
    expect(externalImagesAllowed({ ALLOW_EXTERNAL_IMAGES: 'true' })).toBe(true);
  });
});
