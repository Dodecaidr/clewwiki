/**
 * What an upload is, decided from its first bytes.
 *
 * The type a client declares is a claim, and the file name another; neither is
 * used. An image is whatever its signature says, it is stored as that, and it
 * is only ever served as that with sniffing switched off — so bytes that are
 * also a valid HTML document never reach a browser as anything but a picture.
 *
 * SVG is left out on purpose. It is a document that can carry script, and
 * sanitising one is a project of its own; diagrams have Mermaid and chart
 * blocks, which are rendered from data rather than served as files.
 */

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

export const IMAGE_EXTENSIONS: Record<ImageType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export function isImageType(value: string): value is ImageType {
  return (IMAGE_TYPES as readonly string[]).includes(value);
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

export function detectImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return 'image/gif';
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return 'image/webp';
  return null;
}

/** The address a page body uses for an uploaded image. Relative, so it survives a change of host. */
export function imageHref(imageId: string): string {
  return `/api/v1/images/${imageId}`;
}

const IMAGE_REFERENCE = /\/api\/v1\/images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

/** Every uploaded image a body refers to, once each. */
export function referencedImageIds(body: string): string[] {
  const ids = new Set<string>();
  for (const match of body.matchAll(IMAGE_REFERENCE)) ids.add(match[1]!.toLowerCase());
  return [...ids];
}
