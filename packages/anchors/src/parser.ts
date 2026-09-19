import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { Language, Parser } from 'web-tree-sitter';
import type { Tree } from 'web-tree-sitter';

import { ANCHOR_LANGUAGES } from './types';
import type { AnchorLanguage } from './types';

/**
 * The parser registry.
 *
 * Grammars are loaded as WebAssembly rather than as native tree-sitter
 * bindings on purpose. A native grammar means a compiler toolchain, Python and
 * `node-gyp` inside the runtime image, and a rebuild for every Node release;
 * the WebAssembly build is one file the runtime reads, which is what keeps the
 * application image on plain `node:22-slim`.
 *
 * Where the `.wasm` files come from:
 *
 * - **TypeScript and TSX** — `tree-sitter-typescript`, the grammar's own npm
 *   package, which publishes `tree-sitter-typescript.wasm` and
 *   `tree-sitter-tsx.wasm` alongside its sources.
 * - **Swift** — `@repomix/tree-sitter-wasms`, a prebuilt-WebAssembly
 *   distribution. The Swift grammar's own package ships only C sources, and
 *   building it here would mean either Emscripten or a container runtime in
 *   the build, which is exactly the dependency WebAssembly was chosen to
 *   avoid.
 *
 * Adding a language means adding its declaration table in `declarations.ts`
 * and a `.wasm` file here; nothing else in the pipeline is language-specific.
 */

const require = createRequire(import.meta.url);

/** File names inside `CLEWWIKI_GRAMMARS_DIR`, when that is set. */
const GRAMMAR_FILE_NAMES: Record<AnchorLanguage, string> = {
  swift: 'tree-sitter-swift.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
};

const RUNTIME_FILE_NAME = 'web-tree-sitter.wasm';

/**
 * Where each file comes from in `node_modules`, as path segments rather than
 * as a ready-made specifier.
 *
 * The segments are joined at run time on purpose: a bundler that recognised
 * `'pkg/file.wasm'` as a module request would try to resolve a WebAssembly
 * file as JavaScript and fail. These are file paths handed to `readFile`, not
 * imports, and the shape says so.
 */
const WASM_SOURCES: Record<string, readonly string[]> = {
  [RUNTIME_FILE_NAME]: ['web-tree-sitter', RUNTIME_FILE_NAME],
  'tree-sitter-swift.wasm': ['@repomix/tree-sitter-wasms', 'out', 'tree-sitter-swift.wasm'],
  'tree-sitter-typescript.wasm': ['tree-sitter-typescript', 'tree-sitter-typescript.wasm'],
  'tree-sitter-tsx.wasm': ['tree-sitter-typescript', 'tree-sitter-tsx.wasm'],
  'tree-sitter-kotlin.wasm': ['@tree-sitter-grammars/tree-sitter-kotlin', 'tree-sitter-kotlin.wasm'],
};

/**
 * Overrides where the `.wasm` files are looked up.
 *
 * The bundled application cannot resolve the workspace's `node_modules` layout
 * any more, so the image copies the grammars into one directory and points
 * this at it — the same arrangement `CLEWWIKI_MIGRATIONS_DIR` uses for the SQL.
 */
function grammarsDir(): string | null {
  const configured = process.env.CLEWWIKI_GRAMMARS_DIR;
  return configured && configured.trim() !== '' ? configured : null;
}

/**
 * Where a grammar file might be, most specific first.
 *
 * Three places, because there are three ways this code runs:
 *
 * 1. `CLEWWIKI_GRAMMARS_DIR`, which the container image sets;
 * 2. a `grammars` directory beside the running application, which the web
 *    app's build step fills — a bundled build cannot resolve npm paths at run
 *    time at all, so a copied directory is the only thing it can use;
 * 3. `node_modules`, which is how the library behaves on its own: in its unit
 *    tests, in a script, and anywhere it has not been through a bundler.
 */
function candidatePaths(fileName: string): string[] {
  const candidates: string[] = [];

  const configured = grammarsDir();
  if (configured) candidates.push(path.join(configured, fileName));
  candidates.push(path.join(process.cwd(), 'grammars', fileName));

  try {
    const segments = WASM_SOURCES[fileName];
    if (segments) candidates.push(require.resolve(segments.join('/')));
  } catch {
    // Expected inside a bundle, where module resolution is resolved at build
    // time and a computed specifier has nothing to resolve to. The copied
    // directory above is what serves that case.
  }

  return candidates;
}

/**
 * Reads one `.wasm` file, trying each place it could be.
 *
 * The path is computed rather than written literally, and the bundler is told
 * so: without the marker it treats the read as "this module might open
 * anything" and traces the entire project into the deployment output.
 */
async function readWasm(fileName: string): Promise<Buffer> {
  const tried = candidatePaths(fileName);
  for (const candidate of tried) {
    try {
      return await readFile(/* turbopackIgnore: true */ candidate);
    } catch {
      continue;
    }
  }
  throw new Error(
    `Grammar file ${fileName} was not found. Looked in: ${tried.join(', ')}. ` +
      'Set CLEWWIKI_GRAMMARS_DIR, or run the export-grammars script of @clewwiki/anchors.',
  );
}

let runtimeReady: Promise<void> | null = null;

/**
 * Boots the tree-sitter runtime once per process.
 *
 * The runtime's own `.wasm` is read here and handed over as bytes rather than
 * left to the Emscripten loader to find next to its JavaScript: after bundling
 * that sibling file is not where the loader expects it, and a lookup that
 * works in development and fails in the image is not worth the saved line.
 */
async function initRuntime(): Promise<void> {
  runtimeReady ??= (async () => {
    const wasmBinary = await readWasm(RUNTIME_FILE_NAME);
    await Parser.init({ wasmBinary } as Parameters<typeof Parser.init>[0]);
  })();
  return runtimeReady;
}

const languages = new Map<AnchorLanguage, Promise<Language>>();

/** Loads one grammar, at most once per process. */
export async function loadLanguage(language: AnchorLanguage): Promise<Language> {
  await initRuntime();
  let pending = languages.get(language);
  if (!pending) {
    pending = (async () => {
      const bytes = await readWasm(GRAMMAR_FILE_NAMES[language]);
      return Language.load(bytes);
    })();
    languages.set(language, pending);
  }
  return pending;
}

/**
 * Parses `source` and hands the tree to `use`.
 *
 * The tree and the parser are freed afterwards whatever happens: both hold
 * memory inside the WebAssembly heap, which no garbage collector reclaims.
 */
export async function withTree<T>(
  language: AnchorLanguage,
  source: string,
  use: (tree: Tree) => T,
): Promise<T> {
  const grammar = await loadLanguage(language);
  const parser = new Parser();
  try {
    parser.setLanguage(grammar);
    const tree = parser.parse(source);
    if (tree === null) {
      throw new Error(`Source could not be parsed as ${language}`);
    }
    try {
      return use(tree);
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

/** Loads every grammar, so a misconfigured deployment fails loudly and early. */
export async function loadAllLanguages(): Promise<void> {
  await Promise.all(ANCHOR_LANGUAGES.map((language) => loadLanguage(language)));
}
