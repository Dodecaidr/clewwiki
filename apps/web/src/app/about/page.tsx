import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('about');
  return { title: t('title') };
}

/**
 * The About screen is one of the three attribution placements required by the
 * AGPL-3.0 Section 7 additional terms that ship with this project (the others
 * being the README and the application footer). The attribution line below must
 * stay present and unmodified.
 */
export default async function AboutPage() {
  const t = await getTranslations('about');

  return (
    <div className="grid gap-8">
      <div className="grid gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('what')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('authorHeading')}</CardTitle>
        </CardHeader>
        <CardBody className="text-sm">
          <p>
            clewwiki — created by Dodecaidr (
            <a
              className="underline underline-offset-2"
              href="https://dodecaidr.pro.site"
              rel="noreferrer"
            >
              https://dodecaidr.pro.site
            </a>
            )
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('licenseHeading')}</CardTitle>
        </CardHeader>
        <CardBody className="text-sm text-muted-foreground">
          <p>{t('license')}</p>
        </CardBody>
      </Card>
    </div>
  );
}
