import { CALLOUT_KINDS } from './callouts';
import { chartExampleBlock, CHART_EXAMPLES } from './chart/examples';
import { CHART_LANGUAGE, CHART_LIMITS, CHART_TYPES, chartJsonSchema } from './chart/schema';
import {
  MERMAID_KEYWORDS,
  MERMAID_LANGUAGE,
  MERMAID_MAX_SOURCE_LENGTH,
  MERMAID_TEMPLATES,
} from './mermaid';

/**
 * The format guide an agent reads before writing a page.
 *
 * Everything that can drift is computed rather than written out: the chart
 * types, limits, JSON Schema and examples come from the chart schema module,
 * the diagram keywords and templates from the Mermaid module, the callout
 * kinds from the callout module. A rule changed there is a rule changed here.
 */

/** Longest page body the API accepts, in characters. */
export const PAGE_BODY_MAX_LENGTH = 1_000_000;

export const FORMAT_GUIDE_VERSION = 1;

export interface FormatConstruct {
  name: string;
  markdown: string;
  notes?: string;
}

function fence(language: string, body: string): string {
  return `\`\`\`${language}\n${body}\n\`\`\``;
}

export function buildFormatGuide() {
  const constructs: FormatConstruct[] = [
    {
      name: 'Headings',
      markdown: '# Page title\n\n## Section\n\n### Subsection',
      notes: 'ATX headings (#). Use one # heading at most; sections start at ##.',
    },
    {
      name: 'Emphasis and inline code',
      markdown: '**bold**, *italic*, ~~strikethrough~~ and `inline code`',
    },
    {
      name: 'Links and images',
      markdown: '[Architecture](https://wiki.example.com/spaces/API) and ![Request flow](https://example.com/flow.png)',
      notes:
        'Images are referenced by URL; there is no upload. Whether an external image loads is up to the instance content security policy.',
    },
    {
      name: 'Bullet and numbered lists',
      markdown: '- Gateway\n  - rate limiting\n- Worker\n\n1. Claim the page\n2. Write the body\n3. Release the claim',
      notes: 'Nest by indenting two spaces under a bullet, three under a number.',
    },
    {
      name: 'Task lists',
      markdown: '- [x] Migrations applied\n- [ ] Smoke test passed',
    },
    {
      name: 'Tables with alignment',
      markdown:
        '| Endpoint | Method | p95 (ms) |\n| :--- | :---: | ---: |\n| /api/v1/pages | GET | 42 |\n| /api/v1/pages/{id} | PATCH | 180 |',
      notes: 'The first row is always the header. `:---` left, `:---:` centre, `---:` right. Escape a pipe inside a cell as `\\|`.',
    },
    {
      name: 'Callouts',
      markdown: '> [!WARNING]\n> Deleting a page removes its whole subtree.',
      notes: `A blockquote whose first line is [!KIND]. Kinds: ${CALLOUT_KINDS.join(', ')}. NOTE is information, TIP a recommendation or success, WARNING a risk, CAUTION danger.`,
    },
    {
      name: 'Code blocks',
      markdown: fence('ts title="src/auth.ts"', 'export const ttl = 600;'),
      notes: 'Always fence code and name the language; anything after the language is kept as-is.',
    },
    {
      name: 'Horizontal rule',
      markdown: '---',
    },
  ];

  return {
    version: FORMAT_GUIDE_VERSION,
    format: 'markdown',
    dialect:
      'CommonMark with GitHub Flavored Markdown (tables, task lists, strikethrough, autolinks) and GitHub alert callouts',
    rules: [
      'Page bodies are stored exactly as written: Markdown is the only stored format, and the server never reformats it.',
      'Raw HTML is not rendered. It stays in the stored text but is dropped from the page view and the export; write Markdown instead.',
      'There are no font families, font sizes or text colours; structure a page with headings, lists, tables, callouts, diagrams and charts.',
      `Every ${CHART_LANGUAGE} and ${MERMAID_LANGUAGE} block is checked on write; an invalid one makes the whole write fail with VALIDATION, and nothing is stored.`,
    ],
    constructs,
    mermaid: {
      language: MERMAID_LANGUAGE,
      rendering:
        'Diagrams are drawn in the reader browser. The server only checks that the first diagram line starts with a known keyword; a syntax error inside a diagram is not caught on write and shows as the diagram source on the page.',
      keywords: MERMAID_KEYWORDS,
      max_source_length: MERMAID_MAX_SOURCE_LENGTH,
      templates: MERMAID_TEMPLATES.map((template) => ({
        id: template.id,
        name: template.name,
        keyword: template.keyword,
        markdown: fence(MERMAID_LANGUAGE, template.source),
      })),
    },
    charts: {
      language: CHART_LANGUAGE,
      rendering:
        'Charts are drawn on the server as SVG from the JSON data, in the page view and in the HTML export alike. The block holds data only: no colours, no expressions, no functions.',
      types: CHART_TYPES,
      limits: CHART_LIMITS,
      rules: [
        'The block body is exactly one JSON object. Unknown fields are refused.',
        'bar, line, area and stacked-bar: "x" holds the category labels and every series "data" has exactly as many numbers as "x" has labels.',
        'pie and donut: "x" holds the slice labels, there is exactly one series, values are 0 or more and add up to more than 0.',
        'stacked-bar: every value is 0 or more.',
        'scatter: no "x"; every series "data" is a list of [x, y] number pairs.',
        '"y" is optional: { "min"?: number, "max"?: number, "label"?: string }, with min below max. pie and donut take no "y".',
        '"unit" is optional and is shown after values and on the value axis.',
        `At most ${CHART_LIMITS.maxSeries} series and ${CHART_LIMITS.maxSlices} slices: each gets its own colour from a fixed palette. Fold the rest into "Other".`,
      ],
      json_schema: chartJsonSchema(),
      examples: Object.fromEntries(
        CHART_TYPES.map((type) => [type, { spec: CHART_EXAMPLES[type], markdown: chartExampleBlock(type) }]),
      ),
    },
    conventions: {
      technical: [
        'Written for agents: exact names, paths, contracts, limits and error codes.',
        'Prefer tables for contracts and parameters, fenced code with a language for anything copyable, and callouts for constraints that must not be missed.',
        'Use Mermaid sequence, class, state and ER diagrams where they state a protocol or a data model more precisely than prose.',
      ],
      human: [
        'Written for people: the why, the context and the trade-offs, in plain language.',
        'Explain with diagrams and charts: a flowchart or sequence diagram for how something works, a chart block for numbers, a table for comparisons.',
        'Use callouts for the one or two things a reader must not miss, not for every paragraph.',
      ],
      pairing: [
        'A technical page and a human page on the same subject belong in the same space and section, paired with link_to_page_id on wiki.create_page or with wiki.link_docs.',
        'When one side changes, check whether the other still says the same thing.',
      ],
    },
    validation: {
      applies_to: ['wiki.create_page', 'wiki.write_page', 'POST /api/v1/pages', 'PATCH /api/v1/pages/{id}'],
      error_code: 'VALIDATION',
      details_shape: {
        block_index: 'zero-based position of the first invalid block among the body chart and mermaid blocks',
        line: 'one-based line of that block opening fence in the body',
        language: 'chart or mermaid',
        errors: '[{ path, message }] — path is a dotted path inside the chart JSON, empty for the block as a whole',
        blocks: 'every invalid block, each with block_index, line, language and errors',
      },
      example: {
        code: 'VALIDATION',
        message: 'Chart block 0 at line 3 is not valid: series.0.data: series 0 ("p95") has 2 values but x has 3 labels; they must be equal',
        details: {
          block_index: 0,
          line: 3,
          language: 'chart',
          errors: [
            {
              path: 'series.0.data',
              message: 'series 0 ("p95") has 2 values but x has 3 labels; they must be equal',
            },
          ],
        },
      },
    },
    limits: {
      body_max_characters: PAGE_BODY_MAX_LENGTH,
      title_max_characters: 300,
      summary_max_characters: 2000,
    },
  };
}

export type FormatGuide = ReturnType<typeof buildFormatGuide>;
