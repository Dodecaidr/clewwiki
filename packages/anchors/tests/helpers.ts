import { buildFileIndex, extractDeclarations, languageForPath } from '../src/index';
import type { AnchorTarget, Declaration, FileIndex } from '../src/index';

/** Parses a whole "repository" given as a map of path to source text. */
export async function indexFiles(files: Record<string, string>): Promise<FileIndex> {
  const entries = [];
  for (const [path, source] of Object.entries(files)) {
    const language = languageForPath(path);
    if (language === null) continue;
    entries.push({ path, source, declarations: await extractDeclarations(language, source) });
  }
  return buildFileIndex(entries);
}

export async function declarationsOf(path: string, source: string): Promise<Declaration[]> {
  const language = languageForPath(path);
  if (language === null) throw new Error(`No grammar for ${path}`);
  return extractDeclarations(language, source);
}

export function find(declarations: readonly Declaration[], qualifiedName: string): Declaration {
  const found = declarations.find((entry) => entry.qualifiedName === qualifiedName);
  if (!found) {
    throw new Error(
      `No declaration ${qualifiedName}; found: ${declarations
        .map((entry) => `${entry.kind} ${entry.qualifiedName}`)
        .join(', ')}`,
    );
  }
  return found;
}

/** An anchor as it would have been stored the moment it was created. */
export function anchorFor(
  file: string,
  declaration: Declaration,
  language: AnchorTarget['language'],
): AnchorTarget {
  return {
    language,
    kind: declaration.kind,
    qualifiedName: declaration.qualifiedName,
    container: declaration.container,
    fileHint: file,
    tokenHash: declaration.tokenHash,
    bodyHash: declaration.bodyHash,
    bodyTokenCount: declaration.bodyTokenCount,
    fallback: false,
    lineStart: declaration.startLine,
    lineEnd: declaration.endLine,
  };
}
