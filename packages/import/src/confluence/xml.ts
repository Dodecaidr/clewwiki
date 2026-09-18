/**
 * A tolerant reader for Confluence storage format.
 *
 * Storage format is XHTML with Confluence's own namespaces bolted on
 * (`ac:structured-macro`, `ri:attachment`), and it is not reliably well-formed:
 * bodies carry HTML entities no XML parser knows, unclosed `<br>` and `<img>`,
 * and CDATA inside macro bodies. A strict parser refuses those documents; a DOM
 * implementation would pull a browser-shaped dependency into a package that
 * otherwise runs on strings. So the reader is here, and it is deliberately
 * small: it produces a tree, it never executes anything, and every construct it
 * does not recognise — processing instructions, doctypes, comments — is
 * discarded rather than carried into the output.
 *
 * It is a reader, not a validator. Malformed input produces a tree that is
 * merely odd, never an exception, because the document came from someone else's
 * wiki and refusing the whole space over one stray `<` helps nobody.
 */

export interface XmlElement {
  type: 'element';
  /** Tag name as written, namespace prefix included: `ac:structured-macro`. */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export interface XmlText {
  type: 'text';
  value: string;
}

export type XmlNode = XmlElement | XmlText;

/** Elements that never have a closing tag in the documents this reads. */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
  'ac:emoticon',
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  bull: '•',
  middot: '·',
  deg: '°',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  yen: '¥',
  sect: '§',
  para: '¶',
  times: '×',
  divide: '÷',
  plusmn: '±',
  micro: 'µ',
  frac12: '½',
  frac14: '¼',
  szlig: 'ß',
  larr: '←',
  rarr: '→',
  harr: '↔',
  darr: '↓',
  uarr: '↑',
  check: '✓',
  cross: '✗',
};

/** Expands the entities a storage document actually contains. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body.startsWith('#x') || body.startsWith('#X')
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      // Surrogates and the null character have no business in a page body.
      if (code === 0 || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

const ATTRIBUTE = /([A-Za-z_:][-.\w:]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTRIBUTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE.exec(source)) !== null) {
    const name = match[1];
    if (name === undefined) continue;
    const raw = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[name.toLowerCase()] = decodeEntities(raw);
  }
  return attrs;
}

/**
 * Parses a storage-format fragment into a tree with a synthetic root.
 *
 * A closing tag that matches nothing open is ignored; a closing tag that
 * matches an ancestor closes everything between, which is how a browser reads
 * the same mistake.
 */
export function parseXml(source: string): XmlElement {
  const root: XmlElement = { type: 'element', name: '#root', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  const top = (): XmlElement => stack[stack.length - 1] ?? root;

  const pushText = (value: string): void => {
    if (value === '') return;
    const parent = top();
    const last = parent.children[parent.children.length - 1];
    if (last && last.type === 'text') last.value += value;
    else parent.children.push({ type: 'text', value });
  };

  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('<', cursor);
    if (open === -1) {
      pushText(decodeEntities(source.slice(cursor)));
      break;
    }
    if (open > cursor) pushText(decodeEntities(source.slice(cursor, open)));

    if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open + 9);
      const stop = end === -1 ? source.length : end;
      // CDATA is verbatim: a code macro's body is exactly its bytes.
      pushText(source.slice(open + 9, stop));
      cursor = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4);
      cursor = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<!', open) || source.startsWith('<?', open)) {
      const end = source.indexOf('>', open);
      cursor = end === -1 ? source.length : end + 1;
      continue;
    }

    const close = findTagEnd(source, open);
    if (close === -1) {
      pushText(decodeEntities(source.slice(open)));
      break;
    }
    const inner = source.slice(open + 1, close);
    cursor = close + 1;

    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim().toLowerCase();
      let index = -1;
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth]?.name === name) {
          index = depth;
          break;
        }
      }
      if (index > 0) stack.length = index;
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = /^([A-Za-z_:][-.\w:]*)/.exec(body);
    if (!nameMatch?.[1]) {
      // `<` that was never a tag. Keep it as the text it is.
      pushText(decodeEntities(source.slice(open, cursor)));
      continue;
    }
    const name = nameMatch[1].toLowerCase();
    const element: XmlElement = {
      type: 'element',
      name,
      attrs: parseAttributes(body.slice(nameMatch[1].length)),
      children: [],
    };
    top().children.push(element);

    if (!selfClosing && !VOID_ELEMENTS.has(name)) {
      stack.push(element);
      // A `<script>` or `<style>` body is not markup and must not be parsed as
      // such; it is read to its closing tag and thrown away with the element.
      if (name === 'script' || name === 'style') {
        const end = source.toLowerCase().indexOf(`</${name}`, cursor);
        cursor = end === -1 ? source.length : end;
      }
    }
  }

  return root;
}

/** The `>` that ends a tag, skipping the ones inside quoted attribute values. */
function findTagEnd(source: string, open: number): number {
  let quote: string | null = null;
  for (let index = open + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '>') return index;
  }
  return -1;
}

/** All text below a node, entities already expanded by the parser. */
export function textOf(node: XmlNode): string {
  if (node.type === 'text') return node.value;
  return node.children.map((child) => textOf(child)).join('');
}

/** The first descendant with this tag name, depth first. */
export function findElement(node: XmlNode, name: string): XmlElement | null {
  if (node.type !== 'element') return null;
  for (const child of node.children) {
    if (child.type === 'element') {
      if (child.name === name) return child;
      const found = findElement(child, name);
      if (found) return found;
    }
  }
  return null;
}

/** Direct element children with this tag name. */
export function childrenNamed(node: XmlElement, name: string): XmlElement[] {
  return node.children.filter(
    (child): child is XmlElement => child.type === 'element' && child.name === name,
  );
}
