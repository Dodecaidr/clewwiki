import {
  describeSkillFrontMatterIssue,
  isSkillSlug,
  isSkillTag,
  MAX_SKILL_BODY_BYTES,
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_NAME_LENGTH,
  MAX_SKILL_TAGS,
  MAX_SKILL_VERSION_LENGTH,
  parseSkillFrontMatter,
} from '@clewwiki/content/skill';
import type { SkillFrontMatterIssue } from '@clewwiki/content/skill';

import { PageServiceError } from '../pages/errors';

/**
 * What a writer may send as a skill, and what is refused.
 *
 * A body may arrive as a whole `SKILL.md`. It is split here: the front matter
 * fills in whatever the caller did not pass explicitly, and the Markdown under
 * it is what gets stored. Front matter that does not parse refuses the whole
 * write with `validation` and details naming the field and the line — the same
 * treatment, and the same details shape, an invalid chart block gets, so an
 * agent fixes one named thing and writes again instead of guessing.
 */

export { MAX_SKILL_BODY_BYTES };

export interface SkillInputDraft {
  name?: string;
  description?: string;
  version?: string | null;
  tags?: readonly string[];
  body?: string;
}

export interface NormalizedSkillInput {
  name?: string;
  description?: string;
  version?: string | null;
  tags?: string[];
  body?: string;
}

/** Turns front-matter issues into the `details` a refusal carries. */
export function frontMatterErrorDetails(issues: SkillFrontMatterIssue[]): Record<string, unknown> {
  const [first] = issues;
  return {
    front_matter: true,
    line: first?.line ?? 1,
    errors: issues.map((issue) => ({ path: issue.path, message: issue.message })),
  };
}

function refuse(message: string, details?: Record<string, unknown>): never {
  throw new PageServiceError('validation', message, details);
}

/**
 * Normalises and checks one write.
 *
 * `partial` is true for a PATCH: fields the caller left out keep their stored
 * values, so only what arrived is checked. On a create every required field has
 * to be present by the end, from the arguments or from the front matter.
 */
export function normalizeSkillInput(
  draft: SkillInputDraft,
  options: { partial: boolean },
): NormalizedSkillInput {
  const out: NormalizedSkillInput = {};

  let body = draft.body;
  if (body !== undefined) {
    const parsed = parseSkillFrontMatter(body);
    if (parsed.issues.length > 0) {
      const [first] = parsed.issues;
      refuse(
        first ? describeSkillFrontMatterIssue(first) : 'The SKILL.md front matter is not valid',
        frontMatterErrorDetails(parsed.issues),
      );
    }
    body = parsed.body;
    // Explicit arguments win: a form that sends both is describing the fields
    // it shows, and a caller that sends only a SKILL.md gets its front matter.
    if (draft.name === undefined && parsed.fields.name !== undefined) draft = { ...draft, name: parsed.fields.name };
    if (draft.description === undefined && parsed.fields.description !== undefined) {
      draft = { ...draft, description: parsed.fields.description };
    }
    if (draft.version === undefined && parsed.fields.version !== undefined) {
      draft = { ...draft, version: parsed.fields.version };
    }
    if (draft.tags === undefined && parsed.fields.tags !== undefined) {
      draft = { ...draft, tags: parsed.fields.tags };
    }

    if (Buffer.byteLength(body, 'utf8') > MAX_SKILL_BODY_BYTES) {
      refuse(`A skill body is at most ${MAX_SKILL_BODY_BYTES} bytes`, {
        limit_bytes: MAX_SKILL_BODY_BYTES,
      });
    }
    out.body = body;
  }

  if (draft.name !== undefined) {
    const name = draft.name.trim();
    if (name === '') refuse('A skill needs a name', { fields: { name: ['A skill needs a name'] } });
    if (name.length > MAX_SKILL_NAME_LENGTH) {
      refuse(`A skill name is at most ${MAX_SKILL_NAME_LENGTH} characters`);
    }
    out.name = name;
  }

  if (draft.description !== undefined) {
    const description = draft.description.trim();
    if (description === '') {
      refuse('A skill needs a description: it is what tells an agent when to use it', {
        fields: { description: ['A skill needs a description'] },
      });
    }
    if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
      refuse(`A skill description is at most ${MAX_SKILL_DESCRIPTION_LENGTH} characters`);
    }
    if (/[\r\n]/.test(description)) {
      refuse('A skill description is one line: move the detail into the body');
    }
    out.description = description;
  }

  if (draft.version !== undefined) {
    const version = draft.version === null ? '' : draft.version.trim();
    if (version.length > MAX_SKILL_VERSION_LENGTH) {
      refuse(`A skill version is at most ${MAX_SKILL_VERSION_LENGTH} characters`);
    }
    out.version = version === '' ? null : version;
  }

  if (draft.tags !== undefined) {
    const tags: string[] = [];
    for (const raw of draft.tags) {
      const tag = raw.trim().toLowerCase();
      if (tag === '') continue;
      if (!isSkillTag(tag)) {
        refuse(`"${tag}" is not a usable tag: lowercase words joined by hyphens`, {
          fields: { tags: [`"${tag}" is not a usable tag`] },
        });
      }
      if (!tags.includes(tag)) tags.push(tag);
    }
    if (tags.length > MAX_SKILL_TAGS) {
      refuse(`A skill carries at most ${MAX_SKILL_TAGS} tags`);
    }
    out.tags = tags;
  }

  if (!options.partial) {
    if (out.name === undefined) {
      refuse('A skill needs a name', { fields: { name: ['A skill needs a name'] } });
    }
    if (out.description === undefined) {
      refuse('A skill needs a description: it is what tells an agent when to use it', {
        fields: { description: ['A skill needs a description'] },
      });
    }
  }

  return out;
}

/** Holds a caller-chosen slug to the rules a directory name has to obey. */
export function assertSkillSlug(slug: string): string {
  const value = slug.trim().toLowerCase();
  if (!isSkillSlug(value)) {
    refuse(
      'A skill slug is lowercase words joined by single hyphens, at most 80 characters — it is also the directory the skill installs into',
      { fields: { slug: ['A skill slug is lowercase words joined by single hyphens'] } },
    );
  }
  return value;
}
