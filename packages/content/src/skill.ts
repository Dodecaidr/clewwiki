/**
 * Skills: the `SKILL.md` convention, as this instance reads and writes it.
 *
 * A skill is a reusable instruction package an agent host installs on disk —
 * YAML front matter naming the skill, then a Markdown body. clewwiki stores the
 * two halves apart: `name`, `description`, `version` and `tags` are columns, and
 * `body` is the Markdown *without* front matter. The front matter is rebuilt
 * from the columns whenever a `SKILL.md` is produced, so the list endpoint, the
 * UI and search all read one authority for a skill's name instead of parsing
 * YAML out of a blob.
 *
 * Writers may still send a whole `SKILL.md`. `parseSkillFrontMatter` takes the
 * front matter off and hands back the fields it found; a front matter that does
 * not parse is refused with an error naming the line and the field, the same
 * way an invalid chart block is refused, rather than being stored as prose.
 *
 * The YAML accepted here is deliberately a fragment of YAML: a flat mapping of
 * `key: value` lines. Anything richer — anchors, nested maps, multi-line
 * scalars — is refused rather than half-understood, because a parser that
 * guesses is worse than one that says no.
 */

/** Upper bound on a stored body. Big enough for a long skill, small enough to read in one request. */
export const MAX_SKILL_BODY_BYTES = 262_144;
export const MAX_SKILL_NAME_LENGTH = 100;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1_024;
export const MAX_SKILL_VERSION_LENGTH = 40;
export const MAX_SKILL_SLUG_LENGTH = 80;
export const MAX_SKILL_TAGS = 16;
export const MAX_SKILL_TAG_LENGTH = 40;

/**
 * A slug as it appears in a URL and, more importantly, as a directory name the
 * install command creates. Lowercase words joined by single hyphens and nothing
 * else: no dot, no slash, no separator any file system gives a meaning to.
 */
export const SKILL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSkillSlug(value: string): boolean {
  return value.length <= MAX_SKILL_SLUG_LENGTH && SKILL_SLUG_PATTERN.test(value);
}

/** A tag: the slug rules again, so a tag is always safe in a query string. */
export function isSkillTag(value: string): boolean {
  return value.length <= MAX_SKILL_TAG_LENGTH && SKILL_SLUG_PATTERN.test(value);
}

/** The front-matter keys this instance understands. Each maps onto a column. */
export const SKILL_FRONT_MATTER_KEYS = ['name', 'description', 'version', 'tags'] as const;
export type SkillFrontMatterKey = (typeof SKILL_FRONT_MATTER_KEYS)[number];

/**
 * One problem with a skill's front matter. `path` is the field it is about — or
 * the empty string for the block as a whole — and `line` is one-based within
 * the whole document, so an editor can point straight at it. Same shape as the
 * chart block's `ContentIssue` plus the line, for the same reason.
 */
export interface SkillFrontMatterIssue {
  path: string;
  line: number;
  message: string;
}

export interface SkillFrontMatterFields {
  name?: string;
  description?: string;
  version?: string;
  tags?: string[];
}

export interface SkillFrontMatterResult {
  /** True when the document opened with a front-matter fence. */
  found: boolean;
  fields: SkillFrontMatterFields;
  /** The document with the front matter removed, leading blank lines trimmed. */
  body: string;
  issues: SkillFrontMatterIssue[];
}

const FENCE = '---';

/** Strips one layer of matching quotes, the only quoting this fragment accepts. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseTags(raw: string): string[] {
  const inner = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  return inner
    .split(',')
    .map((entry) => unquote(entry.trim()))
    .filter((entry) => entry !== '');
}

/**
 * Splits a document into front matter and body.
 *
 * A document that does not begin with `---` has no front matter and is returned
 * whole: that is the normal case for a body stored here, since the front matter
 * is generated from the columns. Only a document that *opens* a fence is held
 * to the rules, because only then did the writer mean to write front matter.
 */
export function parseSkillFrontMatter(source: string): SkillFrontMatterResult {
  const text = source.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const issues: SkillFrontMatterIssue[] = [];

  const lines = text.split('\n');
  if (lines[0]?.trim() !== FENCE) {
    return { found: false, fields: {}, body: text, issues };
  }

  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === FENCE) {
      end = index;
      break;
    }
  }
  if (end === -1) {
    issues.push({
      path: '',
      line: 1,
      message: 'The front matter opens with --- but never closes: add a --- line after the fields',
    });
    return { found: true, fields: {}, body: text, issues };
  }

  const fields: SkillFrontMatterFields = {};
  const seen = new Set<string>();

  for (let index = 1; index < end; index += 1) {
    const line = lines[index] ?? '';
    const lineNumber = index + 1;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    if (/^\s/.test(line)) {
      issues.push({
        path: '',
        line: lineNumber,
        message: 'Indented lines are not supported here: write one "key: value" per line',
      });
      continue;
    }

    const separator = line.indexOf(':');
    if (separator <= 0) {
      issues.push({
        path: '',
        line: lineNumber,
        message: `Line ${lineNumber} is not a "key: value" pair`,
      });
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = unquote(line.slice(separator + 1).trim());

    if (!(SKILL_FRONT_MATTER_KEYS as readonly string[]).includes(key)) {
      issues.push({
        path: key,
        line: lineNumber,
        message: `Unknown front matter key "${key}". This instance stores ${SKILL_FRONT_MATTER_KEYS.join(', ')}`,
      });
      continue;
    }
    if (seen.has(key)) {
      issues.push({ path: key, line: lineNumber, message: `"${key}" is given twice` });
      continue;
    }
    seen.add(key);

    if (key === 'tags') {
      fields.tags = parseTags(value);
    } else if (value === '') {
      issues.push({ path: key, line: lineNumber, message: `"${key}" must not be empty` });
    } else {
      fields[key as 'name' | 'description' | 'version'] = value;
    }
  }

  if (!seen.has('name')) {
    issues.push({ path: 'name', line: 1, message: 'The front matter must carry a name' });
  }
  if (!seen.has('description')) {
    issues.push({
      path: 'description',
      line: 1,
      message: 'The front matter must carry a description: it is what tells an agent when to use the skill',
    });
  }

  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '');
  return { found: true, fields, body, issues };
}

/** The first issue, phrased as the message a refusal carries. */
export function describeSkillFrontMatterIssue(issue: SkillFrontMatterIssue): string {
  const where = issue.path === '' ? `line ${issue.line}` : `"${issue.path}" at line ${issue.line}`;
  return `The SKILL.md front matter is not valid: ${where}: ${issue.message}`;
}

/**
 * A scalar as YAML, quoted only when it has to be. Quoting everything would be
 * correct and unreadable; quoting nothing would break on the first description
 * containing a colon.
 */
function yamlScalar(value: string): string {
  const needsQuotes =
    value === '' ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    /:\s/.test(value) ||
    /\s#/.test(value) ||
    value !== value.trim();
  if (!needsQuotes) return value;
  return JSON.stringify(value);
}

export interface SkillMarkdownInput {
  name: string;
  description: string;
  version?: string | null;
  tags?: readonly string[];
  body: string;
}

/**
 * The `SKILL.md` an agent host reads: front matter rebuilt from the stored
 * fields, then the stored body. This is the only place a `SKILL.md` is
 * assembled, so the file the install command writes and the file the web UI
 * offers to copy are the same bytes.
 */
export function buildSkillMarkdown(input: SkillMarkdownInput): string {
  const lines = [FENCE, `name: ${yamlScalar(input.name)}`, `description: ${yamlScalar(input.description)}`];
  if (input.version && input.version.trim() !== '') {
    lines.push(`version: ${yamlScalar(input.version.trim())}`);
  }
  if (input.tags && input.tags.length > 0) {
    lines.push(`tags: [${input.tags.map((tag) => yamlScalar(tag)).join(', ')}]`);
  }
  lines.push(FENCE, '');
  const body = input.body.replace(/\r\n/g, '\n').replace(/^\n+/, '');
  return `${lines.join('\n')}\n${body}${body.endsWith('\n') || body === '' ? '' : '\n'}`;
}
