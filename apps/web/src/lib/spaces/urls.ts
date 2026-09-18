/**
 * Where things live in the web UI. One module so that a route change is one
 * edit, and so the legacy `/pages/{id}` redirects and the links agree.
 */

export function spaceHref(spaceKey: string): string {
  return `/spaces/${encodeURIComponent(spaceKey)}`;
}

export function spaceSettingsHref(spaceKey: string): string {
  return `${spaceHref(spaceKey)}/settings`;
}

export function spacePagesBase(spaceKey: string): string {
  return `${spaceHref(spaceKey)}/pages`;
}

export function spacePageHref(spaceKey: string, pageId: string): string {
  return `${spacePagesBase(spaceKey)}/${pageId}`;
}

export function spacePageEditHref(spaceKey: string, pageId: string): string {
  return `${spacePageHref(spaceKey, pageId)}/edit`;
}

export function newSpacePageHref(spaceKey: string, parentId?: string | null): string {
  const base = `${spacePagesBase(spaceKey)}/new`;
  return parentId ? `${base}?parent=${encodeURIComponent(parentId)}` : base;
}

/**
 * The rules of a space have a stable address whether or not a page has been
 * designated yet: the sidebar always has somewhere to point, and the page
 * behind it says what to do when there are no rules.
 */
export function spaceRulesHref(spaceKey: string): string {
  return `${spaceHref(spaceKey)}/rules`;
}

export function spaceSkillsHref(spaceKey: string): string {
  return `${spaceHref(spaceKey)}/skills`;
}

export function spaceSkillHref(spaceKey: string, slug: string): string {
  return `${spaceSkillsHref(spaceKey)}/${encodeURIComponent(slug)}`;
}

export function spaceSkillEditHref(spaceKey: string, slug: string): string {
  return `${spaceSkillHref(spaceKey, slug)}/edit`;
}

export function newSpaceSkillHref(spaceKey: string): string {
  return `${spaceSkillsHref(spaceKey)}/new`;
}
