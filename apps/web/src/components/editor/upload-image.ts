/**
 * Sends an image to the wiki from the editor.
 *
 * The body of the request is the file itself and its declared type is one of
 * the four the server accepts — which is also what makes the request one a
 * cross-origin page cannot forge. What the image *is* gets decided on the
 * server, from its bytes.
 */

export const UPLOADABLE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export type ImageUploadError = 'type' | 'tooLarge' | 'rateLimited' | 'off' | 'full' | 'generic';

export type ImageUploadResult = { ok: true; url: string } | { ok: false; error: ImageUploadError };

export function isUploadableImage(file: { type: string }): boolean {
  return (UPLOADABLE_IMAGE_TYPES as readonly string[]).includes(file.type);
}

/** The image files in a paste or a drop. */
export function imageFilesOf(transfer: DataTransfer | null | undefined): File[] {
  if (!transfer) return [];
  return [...transfer.files].filter((file) => file.type.startsWith('image/'));
}

export async function uploadImage(endpoint: string, file: File): Promise<ImageUploadResult> {
  if (!isUploadableImage(file)) return { ok: false, error: 'type' };

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
      credentials: 'same-origin',
    });
  } catch {
    return { ok: false, error: 'generic' };
  }

  if (response.ok) {
    try {
      const body = (await response.json()) as { url?: unknown };
      if (typeof body.url === 'string') return { ok: true, url: body.url };
    } catch {
      /* falls through to the generic error */
    }
    return { ok: false, error: 'generic' };
  }

  if (response.status === 413) return { ok: false, error: 'tooLarge' };
  if (response.status === 429) return { ok: false, error: 'rateLimited' };
  if (response.status === 403) return { ok: false, error: 'off' };
  if (response.status === 409) return { ok: false, error: 'full' };
  if (response.status === 400) return { ok: false, error: 'type' };
  return { ok: false, error: 'generic' };
}

/** A name a screen reader can say for a pasted file: the file name without its extension. */
export function altFromFileName(name: string): string {
  const base = name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
  // A pasted screenshot is called "image.png" by every browser; that says nothing.
  return /^image$/i.test(base) ? '' : base.slice(0, 120);
}
