import 'server-only';

import { getTranslations } from 'next-intl/server';

import type { RenderLabels } from './markdown';

/** Callout titles and the invalid-chart heading in the reader's language. */
export async function renderLabels(): Promise<RenderLabels> {
  const t = await getTranslations('content');
  return {
    callouts: {
      NOTE: t('calloutNote'),
      TIP: t('calloutTip'),
      IMPORTANT: t('calloutImportant'),
      WARNING: t('calloutWarning'),
      CAUTION: t('calloutCaution'),
    },
    chartInvalid: t('chartInvalid'),
  };
}
