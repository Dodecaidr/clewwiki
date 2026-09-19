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

/**
 * A space's discussions. A stable address whether or not any thread exists:
 * the sidebar always has somewhere to point, and the page behind it explains
 * what discussions are for when there are none.
 */
export function spaceDiscussionsHref(spaceKey: string): string {
  return `${spaceHref(spaceKey)}/discussions`;
}

export function spaceDiscussionHref(spaceKey: string, discussionId: string): string {
  return `${spaceDiscussionsHref(spaceKey)}/${encodeURIComponent(discussionId)}`;
}

/** The form that opens one, optionally prefilled with the page it is about. */
export function newSpaceDiscussionHref(spaceKey: string, pageId?: string | null): string {
  const base = `${spaceDiscussionsHref(spaceKey)}/new`;
  return pageId ? `${base}?page=${encodeURIComponent(pageId)}` : base;
}

/** Where documentation from another system is brought in. */
export function spaceImportHref(spaceKey: string): string {
  return `${spaceHref(spaceKey)}/import`;
}

/** One staged import: its preview while it waits, its result once applied. */
export function spaceImportRunHref(spaceKey: string, importId: string): string {
  return `${spaceImportHref(spaceKey)}/${importId}`;
}

/** What changed in a space: the review queue, or with `view=all` every revision. */
export function spaceChangesHref(spaceKey: string, view?: 'all'): string {
  const base = `${spaceHref(spaceKey)}/changes`;
  return view ? `${base}?view=${view}` : base;
}

/** The screen that moves a page to another space; `to` preselects the space. */
export function spacePageMoveHref(spaceKey: string, pageId: string, to?: string): string {
  const base = `${spacePageHref(spaceKey, pageId)}/move`;
  return to ? `${base}?to=${encodeURIComponent(to)}` : base;
}

export function spacePageHistoryHref(spaceKey: string, pageId: string): string {
  return `${spacePageHref(spaceKey, pageId)}/history`;
}

/**
 * The comparison of two versions of a page. With no versions it shows what is
 * waiting for a review; `from` may be 0, meaning "before the page existed".
 */
export function spacePageChangesHref(
  spaceKey: string,
  pageId: string,
  range?: { from: number; to: number },
): string {
  const base = `${spacePageHref(spaceKey, pageId)}/changes`;
  return range ? `${base}?from=${range.from}&to=${range.to}` : base;
}
