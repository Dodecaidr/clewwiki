import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { AnchorPanel } from './anchor-panel';
import { ImagePanel } from './image-panel';
import type { AnchorPanelItem, AnchorPanelLabels } from './anchor-panel';
import { DeletePageButton } from './delete-button';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { PageBody } from '@/components/page-body';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { canWrite } from '@/lib/roles';
import { getFallbackShare, listAnchorsForPage } from '@/lib/anchors/service';
import { imageHref, referencedImageIds } from '@/lib/images/detect';
import { listImagesForPage } from '@/lib/images/service';
import type { AnchorRecord } from '@/lib/anchors/service';
import { getActiveClaimsForPage, getActiveNotesForPage } from '@/lib/claims/service';
import { listOpenDiscussionsForPage } from '@/lib/discussions/service';
import { renderMarkdown } from '@/lib/pages/markdown';
import { renderLabels } from '@/lib/pages/render-labels';
import { getAncestors, listRevisions } from '@/lib/pages/service';
import { getPageReviewState } from '@/lib/reviews/service';
import { listPageComments } from '@/lib/comments/service';
import { splitParagraphs } from '@clewwiki/content/paragraphs';
import { CommentableBody } from '@/components/commentable-body';
import { CommentsPanel } from '@/components/comments-panel';
import { readRepositorySettings } from '@/lib/repository/settings';
import { getSessionContext } from '@/lib/session';
import {
  newSpaceDiscussionHref,
  newSpacePageHref,
  spaceDiscussionHref,
  spaceHref,
  spacePageChangesHref,
  spacePageEditHref,
  spacePageMoveHref,
  spacePageHistoryHref,
  spacePageHref,
} from '@/lib/spaces/urls';
import { assertSameWorkspace } from '@/lib/workspace';
import { cn, formatDateTime } from '@/lib/utils';
import { findPage, findSpaceById } from '@/lib/spaces/visibility';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ key: string; id: string }> };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadPage(id: string) {
  const session = await getSessionContext();
  if (!session) return null;
  if (!UUID_PATTERN.test(id)) return null;

  const page = await findPage(session, id);
  if (!page) return null;

  // The query already scoped to the workspace; this re-asserts it on the row
  // about to be rendered, so a change to the query cannot quietly widen what
  // this screen shows.
  assertSameWorkspace(session.workspace.id, page.workspaceId);
  const space = await findSpaceById(session, page.spaceId);
  if (!space) return null;
  return { session, page, space };
}

type AnchorTranslator = Awaited<ReturnType<typeof getTranslations<'anchors'>>>;

/**
 * Turns the stored `detail` blob into one sentence a reader can act on.
 *
 * The blob is JSON written by whichever release last checked the anchor, so
 * every field is read defensively: an older row must not be able to break the
 * page it belongs to.
 */
function describeAnchorDetail(
  anchor: AnchorRecord,
  ta: AnchorTranslator,
): string | null {
  const detail = anchor.detail;
  if (!detail) return null;

  const text = (key: string): string | null => {
    const value = detail[key];
    return typeof value === 'string' ? value : null;
  };

  switch (detail.reason) {
    case 'body_changed':
      return ta('detailBodyChanged');
    case 'moved':
      return ta('detailMoved', { file: text('moved_to') ?? anchor.fileHint });
    case 'renamed':
      return ta('detailRenamed', { name: text('renamed_to') ?? '' });
    case 'moved_and_renamed':
      return ta('detailMovedRenamed', {
        file: text('moved_to') ?? anchor.fileHint,
        name: text('renamed_to') ?? '',
      });
    case 'file_missing':
      return ta('detailFileMissing', { file: text('file') ?? anchor.fileHint });
    case 'declaration_missing':
      return ta('detailDeclarationMissing');
    case 'range_changed':
      return ta('detailRangeChanged');
    case 'range_missing':
      return ta('detailRangeMissing');
    default:
      return null;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const loaded = await loadPage((await params).id);
  return { title: loaded?.page.title ?? 'clewwiki' };
}

export default async function PageView({ params }: Props) {
  const { key, id } = await params;
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }

  const loaded = await loadPage(id);
  if (!loaded) {
    notFound();
  }

  const { page, space } = loaded;
  // A page is addressed under its own space. A link carrying another key — an
  // old bookmark, a hand-edited URL — goes to where the page actually is.
  if (key !== space.key) {
    redirect(spacePageHref(space.key, page.id));
  }
  const t = await getTranslations('pages');
  const ts = await getTranslations('spaces');
  const format = await getFormatter();

  const [
    comments,
    linked,
    revisions,
    activeClaims,
    notes,
    pageAnchors,
    fallbackShare,
    ancestors,
    openDiscussions,
    review,
    pageImages,
  ] = await Promise.all([
      listPageComments(session.workspace.id, page.id, 'all'),
      page.linkedPageId
        ? findPage(session, page.linkedPageId)
        : Promise.resolve(null),
      listRevisions(session.workspace.id, page.id, 5),
      getActiveClaimsForPage(session.workspace.id, page.id),
      getActiveNotesForPage(session.workspace.id, page.id),
      // The state the last check left behind, not a fresh one. Rendering a page
      // must not wait on a network fetch of somebody's repository; "Check now"
      // is the button that asks for that deliberately.
      listAnchorsForPage(session.workspace.id, page.id),
      getFallbackShare(session.workspace.id, space.id),
      getAncestors(session.workspace.id, page),
      listOpenDiscussionsForPage(session.workspace.id, page.id),
      getPageReviewState(session.workspace.id, page.id),
      listImagesForPage(session.workspace.id, page.id),
    ]);

  // The body is rendered once the comments are known, so that a paragraph with
  // unresolved comments is marked in the HTML itself and looks the same before
  // and after the page hydrates.
  const openThreads = comments.threads.filter((thread) => thread.root.resolvedAt === null);
  const resolvedThreads = comments.threads.filter((thread) => thread.root.resolvedAt !== null);
  const threadsByBlock: Record<string, string[]> = {};
  for (const thread of openThreads) {
    if (thread.anchor.state !== 'current') continue;
    (threadsByBlock[String(thread.anchor.blockIndex)] ??= []).push(thread.root.id);
  }
  const html = await renderMarkdown(page.body, await renderLabels(), {
    startLines: splitParagraphs(page.body).map((block) => block.startLine),
    openThreads: new Map(
      Object.entries(threadsByBlock).map(([index, ids]) => [Number(index), ids.length]),
    ),
  });

  const ta = await getTranslations('anchors');
  const ti = await getTranslations('pageImages');
  const imagesInText = new Set(referencedImageIds(page.body));
  const tdis = await getTranslations('discussions');
  const trev = await getTranslations('reviews');
  const repository = readRepositorySettings(space.settings);

  const anchorItems: AnchorPanelItem[] = pageAnchors.map((anchor) => ({
    anchorId: anchor.id,
    state: anchor.state,
    kind: anchor.kind,
    qualifiedName: anchor.qualifiedName,
    fileHint: anchor.fileHint,
    sectionId: anchor.sectionId,
    fallback: anchor.fallback,
    lineStart: anchor.lineStart,
    lineEnd: anchor.lineEnd,
    detailLabel: describeAnchorDetail(anchor, ta),
    lastCheckedLabel: anchor.lastCheckedAt
      ? ta('lastChecked', { at: formatDateTime(format, anchor.lastCheckedAt) ?? '' })
      : null,
  }));

  const anchorLabels: AnchorPanelLabels = {
    heading: ta('heading'),
    empty: ta('empty'),
    noRepository: ta('noRepository'),
    checkNow: ta('checkNow'),
    confirm: ta('confirm'),
    remove: ta('remove'),
    addHeading: ta('addHeading'),
    fileLabel: ta('fileLabel'),
    fileHint: ta('fileHint'),
    targetLabel: ta('targetLabel'),
    targetHint: ta('targetHint'),
    sectionLabel: ta('sectionLabel'),
    sectionHint: ta('sectionHint'),
    add: ta('add'),
    wholePage: ta('wholePage'),
    sectionPrefix: ta('sectionPrefix'),
    fallbackLabel: ta('fallbackLabel'),
    fallbackShare: ta('fallbackShareLabel', { percent: 0 }),
    lastChecked: ta('lastChecked', { at: '' }),
    errorGeneric: ta('errorGeneric'),
    states: {
      fresh: ta('stateFresh'),
      stale: ta('stateStale'),
      'moved-renamed': ta('stateMovedRenamed'),
      lost: ta('stateLost'),
    },
  };

  // A page-level claim outranks a section claim in the header: it is the
  // stronger statement about who may write to this page right now.
  const claim = activeClaims.find((entry) => entry.sectionId === null) ?? activeClaims[0] ?? null;

  return (
    <article className="grid gap-6">
      <header className="grid gap-3 border-b border-border pb-5">
        <Breadcrumbs
          label={ts('breadcrumbLabel')}
          items={[
            { label: space.name, href: spaceHref(space.key) },
            ...ancestors.map((ancestor) => ({
              label: ancestor.title,
              href: spacePageHref(space.key, ancestor.id),
            })),
            { label: page.title },
          ]}
        />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">{page.title}</h1>
            <p className="font-mono text-xs text-muted-foreground">{page.path}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canWrite(session.role) ? (
              <Link
                href={spacePageEditHref(space.key, page.id)}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                {t('edit')}
              </Link>
            ) : null}
            {space.archivedAt || !canWrite(session.role) ? null : (
              <Link
                href={newSpacePageHref(space.key, page.id)}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                {t('addChild')}
              </Link>
            )}
            {/* Prefilled with this page, so a question about it is attached to
                it rather than to the space in general. */}
            {space.archivedAt || !canWrite(session.role) ? null : (
              <Link
                href={newSpaceDiscussionHref(space.key, page.id)}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                {tdis('openAbout')}
              </Link>
            )}

            {/* A details/summary menu: two links, and nothing that needs to
                load before the reader can use them. */}
            <details className="relative">
              <summary
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'sm' }),
                  'cursor-pointer list-none',
                )}
              >
                {t('export')}
              </summary>
              <div className="absolute right-0 z-10 mt-1 grid w-40 gap-1 rounded-(--radius-base) border border-border bg-card p-1 text-sm shadow-sm">
                <a
                  className="rounded-(--radius-base) px-2 py-1.5 hover:bg-secondary"
                  href={`/api/v1/export/${page.id}?format=md`}
                >
                  {t('exportMarkdown')}
                </a>
                <a
                  className="rounded-(--radius-base) px-2 py-1.5 hover:bg-secondary"
                  href={`/api/v1/export/${page.id}?format=html`}
                >
                  {t('exportHtml')}
                </a>
              </div>
            </details>

            {/* A link to a screen, not an action: a move asks where to, and
                says what changes, before anything happens. */}
            {canWrite(session.role) ? (
              <>
                <Link
                  href={spacePageMoveHref(space.key, page.id)}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  {t('move')}
                </Link>
                <DeletePageButton pageId={page.id} label={t('delete')} confirm={t('deleteConfirm')} />
              </>
            ) : null}
          </div>
        </div>

        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          <div className="flex gap-1">
            <dt>{t('kindLabel')}:</dt>
            <dd className="font-medium text-foreground">{t(`kind_${page.kind}`)}</dd>
          </div>
          <div className="flex gap-1">
            <dt>{t('versionLabel')}:</dt>
            <dd className="font-medium text-foreground">{page.version}</dd>
          </div>
          <div className="flex gap-1">
            <dt>{t('updatedLabel')}:</dt>
            <dd className="font-medium text-foreground">{formatDateTime(format, page.updatedAt)}</dd>
          </div>
          <div className="flex gap-1">
            <dt>{t('updatedByLabel')}:</dt>
            <dd className="font-medium text-foreground">
              {page.updatedByType === 'agent' ? t('actorAgent') : t('actorUser')}
            </dd>
          </div>
          <div className="flex gap-1">
            <dt>{t('linkedLabel')}:</dt>
            <dd>
              {linked ? (
                <Link
                  href={spacePageHref(space.key, linked.id)}
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  {linked.title}
                </Link>
              ) : (
                <span>{t('linkedNone')}</span>
              )}
            </dd>
          </div>
        </dl>

        {/* Said above the text, not in the margin: a reader should know that
            what follows was changed by an agent and that nobody has read the
            change yet, before they rely on it. */}
        {review.pending ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-(--radius-base) border border-warning/60 bg-warning/10 px-3 py-2 text-xs">
            <span>
              {review.baselineVersion === 0
                ? trev('bannerCreated')
                : trev('bannerChanged', {
                    count: review.pendingRevisions.length,
                    version: review.baselineVersion,
                  })}
            </span>
            <Link
              href={spacePageChangesHref(space.key, page.id)}
              className="font-medium underline underline-offset-2"
            >
              {trev('reviewLink')}
            </Link>
          </p>
        ) : null}

        {claim ? (
          <p className="rounded-(--radius-base) border border-border bg-muted px-3 py-2 text-xs">
            <span className="font-medium">
              {t('claimHeldBy', {
                name: claim.holderLabel,
                since: formatDateTime(format, claim.createdAt) ?? '—',
              })}
            </span>{' '}
            <span className="text-muted-foreground">
              {claim.sectionId
                ? t('claimSection', { section: claim.sectionId })
                : t('claimWholePage')}
              {' · '}
              {t('claimExpires', { until: formatDateTime(format, claim.expiresAt) ?? '—' })}
            </span>
          </p>
        ) : null}

        {openDiscussions.length > 0 ? (
          <ul className="grid gap-1 text-xs">
            {openDiscussions.map((discussion) => (
              <li key={discussion.id}>
                <Link
                  href={spaceDiscussionHref(space.key, discussion.id)}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  {tdis('openAboutThisPage', { title: discussion.title })}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}

        {notes.length > 0 ? (
          <ul className="grid gap-2">
            {notes.map((note) => (
              <li
                key={note.id}
                className="rounded-(--radius-base) border border-border bg-card px-3 py-2 text-sm"
              >
                {/* A note is text somebody wrote while holding the page. It is
                    shown as their words, with their name on it, and is never
                    folded into the page body. */}
                <p className="whitespace-pre-wrap">{note.text}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('noteBy', {
                    name: note.authorLabel,
                    at: formatDateTime(format, note.createdAt) ?? '—',
                  })}
                </p>
              </li>
            ))}
          </ul>
        ) : null}

        {page.summary ? <p className="text-sm text-muted-foreground">{page.summary}</p> : null}
      </header>

      {page.body.trim() === '' ? (
        <p className="text-sm text-muted-foreground">{t('emptyBody')}</p>
      ) : space.archivedAt || !canWrite(session.role) ? (
        <PageBody html={html} />
      ) : (
        <CommentableBody
          html={html}
          pageId={page.id}
          version={page.version}
          threadsByBlock={threadsByBlock}
        />
      )}

      <CommentsPanel
        pageId={page.id}
        version={page.version}
        open={openThreads}
        resolved={resolvedThreads}
        viewer={{ userId: session.userId, isAdmin: session.role === 'admin', canWrite: canWrite(session.role) }}
        canComment={!space.archivedAt && canWrite(session.role)}
      />

      <AnchorPanel
        readOnly={!canWrite(session.role)}
        pageId={page.id}
        anchors={anchorItems}
        labels={anchorLabels}
        hasRepository={repository !== null}
        fallbackShareLabel={
          fallbackShare.total > 0
            ? ta('fallbackShareLabel', { percent: Math.round(fallbackShare.share * 100) })
            : null
        }
      />

      <ImagePanel
        readOnly={!canWrite(session.role)}
        images={pageImages.map((image) => ({
          imageId: image.id,
          url: imageHref(image.id),
          caption: ti('caption', {
            type: image.contentType.replace('image/', '').toUpperCase(),
            kilobytes: Math.max(1, Math.round(image.byteSize / 1024)),
            date: formatDateTime(format, image.createdAt) ?? '—',
          }),
          inUse: imagesInText.has(image.id),
        }))}
        labels={{
          heading: ti('heading'),
          intro: ti('intro'),
          unused: ti('unused'),
          remove: ti('remove'),
          removeConfirm: ti('removeConfirm'),
          errorNotFound: ti('errorNotFound'),
          errorGeneric: ti('errorGeneric'),
        }}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('historyHeading')}</CardTitle>
          <Link
            href={spacePageHistoryHref(space.key, page.id)}
            className="text-xs underline underline-offset-2"
          >
            {trev('allVersions')}
          </Link>
        </CardHeader>
        <CardBody>
          <ul className="grid gap-2 text-sm">
            {revisions.map((revision) => (
              <li key={revision.version} className="flex flex-wrap gap-x-3 text-muted-foreground">
                <span className="font-medium text-foreground">
                  {t('versionShort', { version: revision.version })}
                </span>
                <span>{formatDateTime(format, revision.createdAt)}</span>
                <span>{revision.authorType === 'agent' ? t('actorAgent') : t('actorUser')}</span>
                <span className="font-mono text-xs">{revision.contentHash.slice(0, 12)}</span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </article>
  );
}
