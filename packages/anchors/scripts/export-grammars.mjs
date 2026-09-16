/**
 * Copies the tree-sitter runtime and every grammar `.wasm` into one directory.
 *
 * The container image needs this because the bundled application no longer has
 * the workspace's `node_modules` layout to resolve them through — the same
 * problem `CLEWWIKI_MIGRATIONS_DIR` solves for the SQL files, solved the same
 * way: copy the files somewhere known, then point an environment variable at
 * it (`CLEWWIKI_GRAMMARS_DIR`).
 *
 * Usage: node scripts/export-grammars.mjs <target directory>
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const SPECIFIERS = [
  'web-tree-sitter/web-tree-sitter.wasm',
  'tree-sitter-typescript/tree-sitter-typescript.wasm',
  'tree-sitter-typescript/tree-sitter-tsx.wasm',
  '@repomix/tree-sitter-wasms/out/tree-sitter-swift.wasm',
];

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/export-grammars.mjs <target directory>');
  process.exit(1);
}

await mkdir(target, { recursive: true });

for (const specifier of SPECIFIERS) {
  const source = require.resolve(specifier);
  const destination = path.join(target, path.basename(source));
  await copyFile(source, destination);
  console.log(`${specifier} -> ${destination}`);
}
