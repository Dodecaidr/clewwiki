import { withTree } from './parser';
import { collectTokens, hashTokenList } from './tokens';
import type { AnchorLanguage, Declaration } from './types';
import type { Node } from 'web-tree-sitter';

/**
 * Declaration extraction.
 *
 * Everything above the grammar is language-independent: walk the tree, take
 * the declarations, hash their tokens. Only the tables below change per
 * language — which node types are declarations, what each is called, and which
 * child holds the body. Adding a language is adding one table.
 */

/**
 * How deep into a file declarations are collected: the top level, and the
 * direct members of a top-level container. A reader anchors a page at `Widget`
 * or at `Widget.render()`; nothing useful is said about a closure three levels
 * inside a method, and indexing them makes every repository-wide search
 * slower for no recall.
 */
const MAX_DEPTH = 2;

/**
 * Shortest body worth matching by hash during rename recovery. An empty or
 * near-empty body (`{}`, `return nil`) collides across unrelated declarations,
 * and a false "renamed to" is worse than an honest "lost".
 */
export const MIN_BODY_TOKENS = 8;

interface LanguageTable {
  /** Node types that hold the members of a container. */
  containerBodyTypes: ReadonlySet<string>;
  /** Node types that count as a declaration's own body, for `bodyHash`. */
  bodyTypes: ReadonlySet<string>;
  /** Kinds whose members are walked one level deeper. */
  containerKinds: ReadonlySet<string>;
  /** Wrapper node types to look inside without treating them as declarations. */
  transparentTypes: ReadonlySet<string>;
  /** One statement may carry several declarations (`const a = 1, b = 2`). */
  expand?: (node: Node) => Node[];
  kindOf: (node: Node) => string | null;
  nameOf: (node: Node, kind: string) => string | null;
}

function fieldNode(node: Node, field: string): Node | null {
  return node.childForFieldName(field);
}

function childOfType(node: Node, types: ReadonlySet<string>): Node | null {
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child && types.has(child.type)) return child;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Swift                                                               */
/* ------------------------------------------------------------------ */

const SWIFT_CONTAINER_KEYWORDS = new Set(['class', 'struct', 'extension', 'enum', 'actor']);

const SWIFT_NAME_TYPES = new Set(['type_identifier', 'simple_identifier', 'user_type']);

function swiftDeclarationName(node: Node): string | null {
  const named = fieldNode(node, 'name');
  if (named) {
    // A stored property's name arrives wrapped in the pattern that binds it.
    if (named.type === 'pattern') {
      const bound = fieldNode(named, 'bound_identifier');
      return (bound ?? named).text;
    }
    return named.text;
  }
  const fallback = childOfType(node, SWIFT_NAME_TYPES);
  return fallback ? fallback.text : null;
}

/**
 * A Swift function's identity includes its argument labels: `move(to:)` and
 * `move(from:)` are different functions, and an anchor on one must not be
 * satisfied by the other.
 */
function swiftFunctionSignature(node: Node): string | null {
  const base = swiftDeclarationName(node);
  if (base === null) return null;
  const labels: string[] = [];
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (!child || child.type !== 'parameter') continue;
    const external = fieldNode(child, 'external_name');
    if (external) {
      labels.push(`${external.text}:`);
      continue;
    }
    const internal = childOfType(child, new Set(['simple_identifier']));
    labels.push(`${internal ? internal.text : '_'}:`);
  }
  return `${base}(${labels.join('')})`;
}

const swiftTable: LanguageTable = {
  containerBodyTypes: new Set(['class_body', 'enum_class_body', 'protocol_body']),
  bodyTypes: new Set([
    'class_body',
    'enum_class_body',
    'protocol_body',
    'function_body',
    'deinit_body',
    'computed_property',
  ]),
  containerKinds: new Set(['class', 'struct', 'enum', 'extension', 'actor', 'protocol']),
  transparentTypes: new Set(['declaration', 'statement']),
  kindOf(node) {
    switch (node.type) {
      case 'class_declaration': {
        for (let index = 0; index < node.childCount; index += 1) {
          const child = node.child(index);
          if (child && SWIFT_CONTAINER_KEYWORDS.has(child.text)) return child.text;
        }
        return 'class';
      }
      case 'protocol_declaration':
        return 'protocol';
      case 'function_declaration':
      case 'protocol_function_declaration':
        return 'func';
      case 'property_declaration':
      case 'protocol_property_declaration': {
        for (let index = 0; index < node.childCount; index += 1) {
          const child = node.child(index);
          if (child && (child.text === 'var' || child.text === 'let')) return child.text;
        }
        return 'var';
      }
      case 'init_declaration':
        return 'init';
      case 'deinit_declaration':
        return 'deinit';
      case 'subscript_declaration':
        return 'subscript';
      case 'typealias_declaration':
        return 'typealias';
      case 'associatedtype_declaration':
        return 'associatedtype';
      default:
        return null;
    }
  },
  nameOf(node, kind) {
    if (kind === 'func') return swiftFunctionSignature(node);
    if (kind === 'init') return 'init';
    if (kind === 'deinit') return 'deinit';
    return swiftDeclarationName(node);
  },
};

/* ------------------------------------------------------------------ */
/* TypeScript and TSX                                                  */
/* ------------------------------------------------------------------ */

const TS_VARIABLE_STATEMENTS = new Set(['lexical_declaration', 'variable_declaration']);

const typescriptTable: LanguageTable = {
  containerBodyTypes: new Set(['class_body', 'interface_body', 'enum_body', 'statement_block']),
  bodyTypes: new Set([
    'statement_block',
    'class_body',
    'interface_body',
    'enum_body',
    'object_type',
    'arrow_function',
    'function_expression',
  ]),
  containerKinds: new Set(['class', 'interface', 'enum', 'namespace']),
  transparentTypes: new Set(['export_statement', 'expression_statement', 'ambient_declaration']),
  expand(node) {
    if (!TS_VARIABLE_STATEMENTS.has(node.type)) return [node];
    const declarators: Node[] = [];
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child && child.type === 'variable_declarator') declarators.push(child);
    }
    return declarators.length > 0 ? declarators : [];
  },
  kindOf(node) {
    switch (node.type) {
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'function_signature':
        return 'function';
      case 'class_declaration':
      case 'abstract_class_declaration':
        return 'class';
      case 'interface_declaration':
        return 'interface';
      case 'type_alias_declaration':
        return 'type';
      case 'enum_declaration':
        return 'enum';
      case 'internal_module':
      case 'module':
        return 'namespace';
      case 'method_definition':
      case 'method_signature':
      case 'abstract_method_signature':
        return 'method';
      case 'public_field_definition':
      case 'property_signature':
        return 'property';
      case 'variable_declarator': {
        const parent = node.parent;
        const keyword = parent?.child(0)?.text;
        return keyword === 'let' || keyword === 'var' ? keyword : 'const';
      }
      default:
        return null;
    }
  },
  nameOf(node) {
    const named = fieldNode(node, 'name');
    if (named) {
      // `const { a, b } = …` binds a pattern rather than a name; a destructured
      // binding has no single declaration to anchor to.
      if (named.type === 'object_pattern' || named.type === 'array_pattern') return null;
      return named.text;
    }
    return null;
  },
};

/* ------------------------------------------------------------------ */
/* Kotlin                                                              */
/* ------------------------------------------------------------------ */

const KOTLIN_RECEIVER_TYPES = new Set(['user_type', 'nullable_type', 'parenthesized_type', 'function_type']);

/**
 * The receiver of an extension, as written: `String` in `fun String.slug()`.
 * It is part of the identity — `String.slug()` and `Path.slug()` are unrelated
 * functions that happen to share a name, and commonly share a file too.
 */
function kotlinReceiver(node: Node): string | null {
  let previous: Node | null = null;
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (!child) continue;
    if (child.type === '.') {
      return previous && KOTLIN_RECEIVER_TYPES.has(previous.type) ? previous.text.replace(/\s+/g, '') : null;
    }
    // The receiver comes before the name; past it there is nothing to find.
    if (child.type === 'function_value_parameters' || child.type === 'variable_declaration') return null;
    if (child.isNamed) previous = child;
  }
  return null;
}

/**
 * Parameter names, in order: `pay(items)` and `pay(item)` are two overloads.
 * Names rather than types, because a name is one token and a type can be a
 * page of generics; two overloads that differ only by type share an identity,
 * and the first in the file is the one an anchor finds.
 */
function kotlinParameterNames(node: Node): string {
  const list = childOfType(node, new Set(['function_value_parameters']));
  const names: string[] = [];
  if (list) {
    for (let index = 0; index < list.childCount; index += 1) {
      const child = list.child(index);
      if (!child || child.type !== 'parameter') continue;
      const name = childOfType(child, new Set(['identifier']));
      names.push(name ? name.text : '_');
    }
  }
  return `(${names.join(', ')})`;
}

function kotlinWithReceiver(node: Node, name: string): string {
  const receiver = kotlinReceiver(node);
  return receiver === null ? name : `${receiver}.${name}`;
}

const kotlinTable: LanguageTable = {
  containerBodyTypes: new Set(['class_body', 'enum_class_body']),
  bodyTypes: new Set(['function_body', 'class_body', 'enum_class_body', 'block', 'getter']),
  containerKinds: new Set(['class', 'interface', 'object', 'enum']),
  // A companion's members are reached the way Kotlin code reaches them, as
  // members of the class: `Checkout.create`, not `Checkout.Companion.create`.
  transparentTypes: new Set(['companion_object', 'class_body']),
  kindOf(node) {
    switch (node.type) {
      case 'class_declaration': {
        let kind = 'class';
        for (let index = 0; index < node.childCount; index += 1) {
          const child = node.child(index);
          if (!child) continue;
          if (child.type === 'interface') return 'interface';
          if (child.type === 'modifiers' && /(^|\s)enum(\s|$)/.test(child.text)) kind = 'enum';
        }
        return kind;
      }
      case 'object_declaration':
        return 'object';
      case 'function_declaration':
        return 'fun';
      case 'property_declaration': {
        for (let index = 0; index < node.childCount; index += 1) {
          const child = node.child(index);
          if (child && (child.type === 'val' || child.type === 'var')) return child.type;
        }
        return 'val';
      }
      case 'type_alias':
        return 'typealias';
      case 'secondary_constructor':
        return 'constructor';
      default:
        return null;
    }
  },
  nameOf(node, kind) {
    if (kind === 'constructor') return `constructor${kotlinParameterNames(node)}`;
    if (kind === 'typealias') return fieldNode(node, 'type')?.text ?? null;
    if (kind === 'val' || kind === 'var') {
      // `val (a, b) = pair` binds a pattern; there is no one declaration to anchor to.
      const declared = childOfType(node, new Set(['variable_declaration']));
      const name = declared ? childOfType(declared, new Set(['identifier'])) : null;
      return name ? kotlinWithReceiver(node, name.text) : null;
    }
    const named = fieldNode(node, 'name');
    if (!named) return null;
    if (kind === 'fun') return kotlinWithReceiver(node, `${named.text}${kotlinParameterNames(node)}`);
    return named.text;
  },
};

const TABLES: Record<AnchorLanguage, LanguageTable> = {
  swift: swiftTable,
  typescript: typescriptTable,
  tsx: typescriptTable,
  kotlin: kotlinTable,
};

/* ------------------------------------------------------------------ */
/* Extraction                                                          */
/* ------------------------------------------------------------------ */

function bodyNodeOf(node: Node, table: LanguageTable): Node | null {
  const declared = fieldNode(node, 'body');
  if (declared) return declared;
  const value = fieldNode(node, 'value');
  if (value && table.bodyTypes.has(value.type)) {
    const inner = fieldNode(value, 'body');
    return inner ?? value;
  }
  return childOfType(node, table.bodyTypes);
}

function containerBodyOf(node: Node, table: LanguageTable): Node | null {
  const declared = fieldNode(node, 'body');
  if (declared && table.containerBodyTypes.has(declared.type)) return declared;
  return childOfType(node, table.containerBodyTypes);
}

function describe(node: Node, kind: string, container: string | null, table: LanguageTable) {
  const name = table.nameOf(node, kind);
  if (name === null || name === '') return null;

  const body = bodyNodeOf(node, table);
  const bodyTokens = body ? collectTokens(body) : [];

  const declaration: Declaration = {
    kind,
    qualifiedName: container === null ? name : `${container}.${name}`,
    container,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    tokenHash: hashTokenList(collectTokens(node)),
    bodyHash: bodyTokens.length > 0 ? hashTokenList(bodyTokens) : null,
    bodyTokenCount: bodyTokens.length,
  };
  return declaration;
}

/**
 * Every declaration in one source file, in source order.
 *
 * Unnamed declarations are skipped rather than given a synthetic name: an
 * anchor whose identity the server invented is an anchor nobody can re-create
 * by hand, and a default export with no name is exactly the block a line-range
 * fallback exists for.
 */
export async function extractDeclarations(
  language: AnchorLanguage,
  source: string,
): Promise<Declaration[]> {
  const table = TABLES[language];
  return withTree(language, source, (tree) => {
    const found: Declaration[] = [];

    const visit = (parent: Node, container: string | null, depth: number): void => {
      if (depth > MAX_DEPTH) return;

      for (let index = 0; index < parent.childCount; index += 1) {
        const child = parent.child(index);
        if (!child) continue;

        if (table.transparentTypes.has(child.type)) {
          visit(child, container, depth);
          continue;
        }

        const candidates = table.expand ? table.expand(child) : [child];
        for (const candidate of candidates) {
          const kind = table.kindOf(candidate);
          if (kind === null) continue;

          const declaration = describe(candidate, kind, container, table);
          if (declaration === null) continue;
          found.push(declaration);

          if (table.containerKinds.has(kind)) {
            const body = containerBodyOf(candidate, table);
            if (body) visit(body, declaration.qualifiedName, depth + 1);
          }
        }
      }
    };

    visit(tree.rootNode, null, 1);
    return found;
  });
}
