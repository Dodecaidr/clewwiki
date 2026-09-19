import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * A restricted space is kept from people who are not in it at the places where a
 * space or a page is looked up. REST handlers do that against the caller's
 * identity; pages and server actions do it by looking things up through
 * `lib/spaces/visibility` and `lib/spaces/guards` with the session as the
 * viewer. That second half is a convention, and a convention that guards who
 * can read what is worth a test that fails when it is broken — by this file, not
 * by somebody noticing a page they should not have seen.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return filesUnder(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

/** Pages, layouts, server actions and components: everything a session reaches that is not REST. */
const interfaceFiles = [...filesUnder(path.join(root, 'app')), ...filesUnder(path.join(root, 'components'))].filter(
  (file) => !file.includes(`${path.sep}app${path.sep}api${path.sep}`),
);

const relative = (file: string): string => path.relative(root, file);

describe('interface code and restricted spaces', () => {
  it('has something to check', () => {
    expect(interfaceFiles.length).toBeGreaterThan(60);
  });

  it('never looks a space or a page up without saying who is asking', () => {
    // By-id loaders count too, metadata included: a title reaches the browser
    // even when the page goes on to answer "not found".
    const unguarded =
      /\b(getSpaceByKey|getSpaceById|getPageById|getPageByPath|requirePage|listSpaces|getDiscussionById|getDiscussionThread|getAnchorById|getClaimById|getComment)\s*\(/;
    const offenders = interfaceFiles.filter((file) => unguarded.test(readFileSync(file, 'utf8'))).map(relative);
    expect(offenders).toEqual([]);
  });

  it('scopes every listing that spans spaces to the spaces the session can see', () => {
    const spanning = /\b(getPresence|listSpaceSummaries|searchPages|getInbox|countUnread)\s*\(([\s\S]*?)\)\s*;/g;
    const offenders: string[] = [];
    let seen = 0;
    for (const file of interfaceFiles) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(spanning)) {
        seen += 1;
        if (!/spaceIds/.test(match[2] ?? '')) offenders.push(`${relative(file)}: ${match[1]}`);
      }
    }
    // The pattern has to be finding the calls for their absence from the list to mean anything.
    expect(seen).toBeGreaterThanOrEqual(5);
    expect(offenders).toEqual([]);
  });

  it('checks an id before handing it to a service, in every action that takes one', () => {
    // Actions that receive the id of a page, a claim, an anchor, a comment or a
    // discussion from a form. Each must go through a guarded lookup first.
    const takesAnId = /formText\(formData, '(pageId|threadId|commentId|discussionId|anchorId)'\)|formData\.get\('(pageId|anchorId)'\)|\((pageId|claimId): string\)/;
    const guarded =
      /\b(canViewPage|canViewClaim|canViewAnchor|canViewComment|canViewDiscussion|findPage|findSpaceById|findDiscussion|findAnchor)\s*\(/;
    const actionFiles = interfaceFiles.filter((file) => /^'use server';/.test(readFileSync(file, 'utf8')));
    expect(actionFiles.length).toBeGreaterThanOrEqual(8);

    const offenders = actionFiles
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return takesAnId.test(source) && !guarded.test(source);
      })
      .map(relative);
    expect(offenders).toEqual([]);

    // And, function by function, for the ones whose whole job is an id.
    const perFunction: Array<[string, string, RegExp]> = [
      ['app/pages/claim-actions.ts', 'acquireClaimAction', /canViewPage/],
      ['app/pages/claim-actions.ts', 'renewClaimAction', /canViewClaim/],
      ['app/pages/claim-actions.ts', 'releaseClaimAction', /canViewClaim/],
      ['app/pages/anchor-actions.ts', 'createAnchorAction', /canViewPage/],
      ['app/pages/anchor-actions.ts', 'checkAnchorsAction', /canViewPage/],
      ['app/pages/anchor-actions.ts', 'confirmAnchorAction', /findAnchor/],
      ['app/pages/anchor-actions.ts', 'deleteAnchorAction', /canViewAnchor/],
      ['app/pages/actions.ts', 'updatePageAction', /canViewPage/],
      ['app/pages/actions.ts', 'deletePageAction', /findPage/],
      ['app/pages/actions.ts', 'linkPageAction', /canViewPage/],
      ['app/pages/actions.ts', 'movePageAction', /findPage[\s\S]*findSpaceByKey/],
      ['app/pages/image-actions.ts', 'deleteImageAction', /getImageAccess[\s\S]*canView\(/],
      ['app/spaces/comment-actions.ts', 'openCommentAction', /canViewPage/],
      ['app/spaces/comment-actions.ts', 'replyCommentAction', /canViewComment/],
      ['app/spaces/comment-actions.ts', 'resolveCommentAction', /canViewComment/],
      ['app/spaces/comment-actions.ts', 'deleteCommentAction', /canViewComment/],
      ['app/spaces/discussion-actions.ts', 'postDiscussionMessageAction', /canViewDiscussion/],
      ['app/spaces/discussion-actions.ts', 'resolveDiscussionAction', /canViewDiscussion/],
      ['app/spaces/discussion-actions.ts', 'deleteDiscussionAction', /findDiscussion/],
      ['app/spaces/review-actions.ts', 'reviewPageAction', /findPage/],
    ];
    const missing = perFunction
      .filter(([file, name, check]) => {
        const source = readFileSync(path.join(root, file), 'utf8');
        const start = source.indexOf(`export async function ${name}(`);
        if (start === -1) return true;
        const next = source.indexOf('\nexport async function ', start + 1);
        return !check.test(source.slice(start, next === -1 ? undefined : next));
      })
      .map(([file, name]) => `${file}: ${name}`);
    expect(missing).toEqual([]);
  });
});
