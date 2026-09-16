import { getTranslations } from 'next-intl/server';

export default async function NotFound() {
  const t = await getTranslations('errors');

  return (
    <div className="grid gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">{t('notFoundTitle')}</h1>
      <p className="text-sm text-muted-foreground">{t('notFoundBody')}</p>
    </div>
  );
}
