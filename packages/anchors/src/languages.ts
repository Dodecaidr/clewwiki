import type { AnchorLanguage } from './types';

/**
 * Which grammar a path is parsed with.
 *
 * File extensions are the only signal available here — the library never reads
 * anything but the bytes it is handed, and in particular never runs a file to
 * find out what it is.
 */
const BY_EXTENSION: Record<string, AnchorLanguage> = {
  '.swift': 'swift',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
};

export function languageForPath(filePath: string): AnchorLanguage | null {
  const lower = filePath.toLowerCase();
  // `.d.ts` is TypeScript, and the longest extension wins over `.ts` anyway.
  for (const [extension, language] of Object.entries(BY_EXTENSION)) {
    if (lower.endsWith(extension)) return language;
  }
  return null;
}

/** Every extension the indexer bothers to read from a repository. */
export const SOURCE_EXTENSIONS: readonly string[] = Object.keys(BY_EXTENSION);
