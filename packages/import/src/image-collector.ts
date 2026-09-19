/**
 * Finding, inside an archive, the images its documents show.
 *
 * Both archive sources use it the same way: one collector per import, one
 * resolver per document. The resolver is handed to `rewriteRelativeLinks`, and
 * what the documents turned out to refer to is read back at the end — so an
 * image nobody shows is never part of the import, however many the archive has.
 */

import { directoryOf, extensionOf, resolvePath } from './doctree';
import { IMPORTABLE_IMAGE_EXTENSIONS } from './images';
import type { ImportAsset } from './images';
import type { ZipFile } from './zip';

export interface ImageCollector {
  /** A resolver for the images of the document stored at `entryName`. */
  resolverFor(entryName: string): (relativePath: string) => string | null;
  /** The images that were resolved at least once, in the order they were first seen. */
  assets(): ImportAsset[];
  /** How many archive entries were taken as images. */
  readonly used: number;
}

export function createImageCollector(entries: readonly ZipFile[]): ImageCollector {
  const images = new Map<string, ZipFile>();
  for (const entry of entries) {
    if (IMPORTABLE_IMAGE_EXTENSIONS.has(extensionOf(entry.name))) images.set(entry.name, entry);
  }
  const used = new Map<string, ImportAsset>();

  return {
    resolverFor(entryName) {
      const from = directoryOf(entryName);
      return (relativePath) => {
        const resolved = resolvePath(from, relativePath);
        if (resolved === null) return null;
        const entry = images.get(resolved);
        if (entry === undefined) return null;
        if (!used.has(resolved)) used.set(resolved, { key: resolved, data: entry.data });
        return resolved;
      };
    },
    assets: () => [...used.values()],
    get used() {
      return used.size;
    },
  };
}
