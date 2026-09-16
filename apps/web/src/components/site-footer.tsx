import { useTranslations } from 'next-intl';

/**
 * The attribution line is a licensing requirement, not decoration: AGPL-3.0
 * Section 7(b) additional terms require it to stay visible in the footer and on
 * the About screen. Do not remove or reword it.
 */
export function SiteFooter() {
  const t = useTranslations('common');

  return (
    <footer className="border-t border-border">
      <div className="mx-auto w-full max-w-4xl px-6 py-6 text-sm text-muted-foreground">
        <p>
          clewwiki — created by Dodecaidr (
          <a className="underline underline-offset-2 hover:text-foreground" href={t('authorSite')}>
            {t('authorSite')}
          </a>
          )
        </p>
      </div>
    </footer>
  );
}
