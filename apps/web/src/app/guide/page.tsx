import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { getSessionContext } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('guide');
  return { title: t('title') };
}

/**
 * A block of a guide section. Paragraph and list texts are message keys under
 * `guide.<section>`; `code` blocks are shown verbatim through `t.raw`, so an
 * example is never run through the message formatter.
 */
type Block =
  | { type: 'p'; key: string }
  | { type: 'ul'; keys: string[] }
  | { type: 'code'; key: string };

interface Section {
  id: string;
  blocks: Block[];
}

const p = (key: string): Block => ({ type: 'p', key });
const ul = (...keys: string[]): Block => ({ type: 'ul', keys });
const code = (key: string): Block => ({ type: 'code', key });

const SECTIONS: Section[] = [
  {
    id: 'what',
    blocks: [p('p1'), p('p2'), ul('kindTechnical', 'kindHuman'), p('p3'), p('p4')],
  },
  {
    id: 'spaces',
    blocks: [
      p('p1'),
      ul('space', 'section', 'page'),
      p('p2'),
      ul('structureOne', 'structureSections', 'structurePairs'),
      code('example'),
      p('p3'),
      p('p4'),
      p('p5'),
    ],
  },
  {
    id: 'writing',
    blocks: [
      p('p1'),
      ul('parent', 'titleField', 'segment', 'kind', 'body'),
      p('p2'),
      code('mermaidExample'),
      p('p3'),
      p('p4'),
      p('p5'),
      p('p6'),
      p('p7'),
    ],
  },
  {
    id: 'claims',
    blocks: [p('p1'), p('p2'), p('p3'), p('p4'), p('p5'), p('p6')],
  },
  {
    id: 'anchors',
    blocks: [p('p1'), p('p2'), p('p3'), ul('fresh', 'stale', 'moved', 'lost'), p('p4'), p('p5')],
  },
  {
    id: 'tokens',
    blocks: [
      p('p1'),
      p('p2'),
      ul('scopeIdentity', 'scopePagesRead', 'scopePagesWrite', 'scopePagesDelete', 'scopeAudit'),
      p('p3'),
      p('p4'),
      p('pSpaces'),
      p('p5'),
      ul('comboRead', 'comboWrite', 'comboCi'),
      p('p6'),
    ],
  },
  {
    id: 'roles',
    blocks: [p('p1'), ul('admin', 'editor'), p('p2'), p('p3')],
  },
  {
    id: 'more',
    blocks: [ul('search', 'export', 'audit')],
  },
];

function inlineLink(href: string) {
  function GuideLink(chunks: ReactNode) {
    return (
      <Link href={href} className="underline underline-offset-2 hover:text-foreground">
        {chunks}
      </Link>
    );
  }
  return GuideLink;
}

const richTags = {
  code: (chunks: ReactNode) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{chunks}</code>
  ),
  strong: (chunks: ReactNode) => <strong className="font-semibold text-foreground">{chunks}</strong>,
  spacesLink: inlineLink('/'),
  presenceLink: inlineLink('/presence'),
  tokensLink: inlineLink('/tokens'),
  connectLink: inlineLink('/connect'),
};

/**
 * The in-app guide: what clewwiki is and how each part of it works, written
 * for someone opening it for the first time. All text comes from the message
 * files, so it reads in the interface language.
 */
export default async function GuidePage() {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }

  const t = await getTranslations('guide');

  return (
    <div className="grid gap-8">
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      <nav aria-label={t('tocTitle')} className="grid gap-2 text-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('tocTitle')}
        </p>
        <ol className="grid list-decimal gap-1 pl-5">
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`} className="underline-offset-2 hover:underline">
                {t(`${section.id}.title`)}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {SECTIONS.map((section) => (
        <Card key={section.id} id={section.id} className="scroll-mt-6">
          <CardHeader>
            <CardTitle>{t(`${section.id}.title`)}</CardTitle>
          </CardHeader>
          <CardBody className="grid gap-3 text-sm leading-relaxed text-muted-foreground">
            {section.blocks.map((block, index) => {
              if (block.type === 'p') {
                return <p key={index}>{t.rich(`${section.id}.${block.key}`, richTags)}</p>;
              }
              if (block.type === 'ul') {
                return (
                  <ul key={index} className="grid list-disc gap-1.5 pl-5">
                    {block.keys.map((key) => (
                      <li key={key}>{t.rich(`${section.id}.${key}`, richTags)}</li>
                    ))}
                  </ul>
                );
              }
              return (
                <pre
                  key={index}
                  className="overflow-x-auto rounded-(--radius-base) border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground"
                >
                  {String(t.raw(`${section.id}.${block.key}`))}
                </pre>
              );
            })}
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
