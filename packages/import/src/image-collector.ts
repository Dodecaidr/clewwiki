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
import type { DeferredZipFile, ZipFile } from './zip';

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

/**
 * The same for files that are neither documents nor images: whatever a
 * document links to that is in the archive and is not itself a page. They were
 * not read with the rest of the archive; one is read when a document first
 * links to it, and only while it fits in `budget` — the part of the import's
 * expanded-size limit the documents and images left. A file past it stays a
 * link, which the page's warnings say.
 */
export interface FileCollector extends ImageCollector {
  /** Files a document linked to that did not fit in the budget. */
  readonly overBudget: string[];
}

export function createFileCollector(deferred: readonly DeferredZipFile[], budget: number): FileCollector {
  const files = new Map<string, DeferredZipFile>();
  for (const entry of deferred) files.set(entry.name, entry);
  const used = new Map<string, ImportAsset>();
  const overBudget = new Set<string>();
  let left = budget;

  return {
    resolverFor(entryName) {
      const from = directoryOf(entryName);
      return (relativePath) => {
        const resolved = resolvePath(from, relativePath);
        if (resolved === null) return null;
        if (used.has(resolved)) return resolved;
        const entry = files.get(resolved);
        if (entry === undefined) return null;
        if (entry.size > left) {
          overBudget.add(resolved);
          return null;
        }
        const data = entry.read();
        left -= data.byteLength;
        used.set(resolved, { key: resolved, data });
        return resolved;
      };
    },
    assets: () => [...used.values()],
    get used() {
      return used.size;
    },
    get overBudget() {
      return [...overBudget];
    },
  };
}
