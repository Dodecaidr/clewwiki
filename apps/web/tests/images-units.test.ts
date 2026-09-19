import { describe, expect, it } from 'vitest';

import { altFromFileName, isUploadableImage } from '@/components/editor/upload-image';
import { checkImageUploadMutation } from '@/lib/csrf';
import { detectImageType, imageHref, referencedImageIds } from '@/lib/images/detect';

const bytes = (...values: number[]) => new Uint8Array(values);
const ascii = (text: string) => new TextEncoder().encode(text);

describe('what an upload is', () => {
  it('is decided from the signature', () => {
    expect(detectImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png');
    expect(detectImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(detectImageType(ascii('GIF89a....'))).toBe('image/gif');
    expect(detectImageType(ascii('GIF87a....'))).toBe('image/gif');
    expect(detectImageType(ascii('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
  });

  it('is nothing when the bytes are anything else', () => {
    expect(detectImageType(ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'))).toBeNull();
    expect(detectImageType(ascii('<!doctype html><script>alert(1)</script>'))).toBeNull();
    expect(detectImageType(ascii('RIFF\0\0\0\0WAVEfmt '))).toBeNull();
    expect(detectImageType(ascii('%PDF-1.7'))).toBeNull();
    expect(detectImageType(bytes(0x89, 0x50))).toBeNull();
    expect(detectImageType(bytes())).toBeNull();
  });
});

describe('image addresses in a body', () => {
  const a = '3f0c9f0e-1c1a-4d8e-9b57-0d6f6a3a2b11';
  const b = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';

  it('are found once each, whatever their case', () => {
    const body = `![one](${imageHref(a)}) and again ![one](${imageHref(a)})\n\n<img src="/api/v1/images/${b}">`;
    expect(referencedImageIds(body)).toEqual([a, b.toLowerCase()]);
  });

  it('are not found in addresses that only look similar', () => {
    expect(referencedImageIds('![x](/api/v1/images/not-an-id) ![y](/api/v1/pages/' + a + ')')).toEqual([]);
  });
});

describe('the cross-origin check of an image upload', () => {
  const base = 'https://wiki.example';
  const request = (headers: Record<string, string>, method = 'POST') => ({
    method,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  });

  it('passes a same-origin upload that declares an image', () => {
    expect(checkImageUploadMutation(request({ origin: base, 'content-type': 'image/png' }), base).ok).toBe(true);
    expect(checkImageUploadMutation(request({ origin: base, 'content-type': 'image/webp' }), base).ok).toBe(true);
    expect(checkImageUploadMutation(request({}, 'GET'), base).ok).toBe(true);
  });

  it('requires a matching Origin outright', () => {
    expect(checkImageUploadMutation(request({ 'content-type': 'image/png' }), base).ok).toBe(false);
    expect(checkImageUploadMutation(request({ origin: 'https://evil.example', 'content-type': 'image/png' }), base).ok).toBe(false);
    // Sec-Fetch-Site is one of two ways to pass for JSON; here it is not enough.
    expect(checkImageUploadMutation(request({ 'sec-fetch-site': 'same-origin', 'content-type': 'image/png' }), base).ok).toBe(false);
  });

  it('refuses every content type a plain form can send, and SVG', () => {
    for (const type of ['multipart/form-data; boundary=x', 'text/plain', 'application/x-www-form-urlencoded', 'image/svg+xml', 'application/octet-stream', '']) {
      expect(checkImageUploadMutation(request({ origin: base, 'content-type': type }), base).ok, type).toBe(false);
    }
  });
});

describe('the editor side of an upload', () => {
  it('offers only the types the server takes', () => {
    expect(isUploadableImage({ type: 'image/png' })).toBe(true);
    expect(isUploadableImage({ type: 'image/svg+xml' })).toBe(false);
    expect(isUploadableImage({ type: '' })).toBe(false);
  });

  it('makes a description out of a file name, and nothing out of a pasted screenshot', () => {
    expect(altFromFileName('deploy_pipeline-overview.png')).toBe('deploy pipeline overview');
    expect(altFromFileName('image.png')).toBe('');
  });
});
