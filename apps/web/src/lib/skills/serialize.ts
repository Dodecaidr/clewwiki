import { buildSkillMarkdown } from '@clewwiki/content/skill';

import type { ActorResource } from '../pages/serialize';
import {
  buildSkillsInstallCommand,
  DEFAULT_SKILLS_DIR,
  skillInstallPath,
  skillsInstallInvocation,
} from './install';
import type { SkillRecord } from './service';

/**
 * Wire shapes for skills, in the snake_case of the rest of the API.
 *
 * Two of them. A listing entry is what a chooser needs — name, description,
 * version, tags, when it last changed — and carries no body, because a listing
 * of thirty skills should not be thirty Markdown documents. The full resource
 * adds the body, the assembled `SKILL.md` and the hints that say how to put it
 * on a machine.
 */

export interface SkillListEntryResource {
  slug: string;
  name: string;
  description: string;
  version: string | null;
  tags: string[];
  updated_at: string;
}

export interface SkillInstallHints {
  /** The command, with this instance's URL and this space already in it. */
  command: string;
  /** The same thing as the installed binary, for documentation. */
  invocation: string;
  /** Where that command writes this skill under the default directory. */
  path: string;
  default_directory: string;
  filename: 'SKILL.md';
}

export interface SkillResource extends SkillListEntryResource {
  space: { key: string; name: string };
  /** The Markdown body, without front matter. */
  body: string;
  /** Front matter rebuilt from the fields above, then the body: the file itself. */
  skill_md: string;
  created_at: string;
  created_by: ActorResource;
  updated_by: ActorResource;
  install: SkillInstallHints;
}

export function toSkillListEntry(skill: SkillRecord): SkillListEntryResource {
  return {
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    tags: skill.tags,
    updated_at: skill.updatedAt.toISOString(),
  };
}

export function skillMarkdown(skill: SkillRecord): string {
  return buildSkillMarkdown({
    name: skill.name,
    description: skill.description,
    version: skill.version,
    tags: skill.tags,
    body: skill.body,
  });
}

export function toSkillResource(
  skill: SkillRecord,
  space: { key: string; name: string },
  options: { baseUrl: string },
): SkillResource {
  return {
    ...toSkillListEntry(skill),
    space: { key: space.key, name: space.name },
    body: skill.body,
    skill_md: skillMarkdown(skill),
    created_at: skill.createdAt.toISOString(),
    created_by: { type: skill.createdByType, id: skill.createdById },
    updated_by: { type: skill.updatedByType, id: skill.updatedById },
    install: {
      command: buildSkillsInstallCommand({
        baseUrl: options.baseUrl,
        spaceKey: space.key,
        slug: skill.slug,
      }),
      invocation: skillsInstallInvocation({ spaceKey: space.key, slug: skill.slug }),
      path: skillInstallPath(skill.slug),
      default_directory: DEFAULT_SKILLS_DIR,
      filename: 'SKILL.md',
    },
  };
}
