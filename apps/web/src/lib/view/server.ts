import 'server-only';

import { cookies } from 'next/headers';

import { THEME_COOKIE, WIDTH_COOKIE, readTheme, readWidth } from './prefs';
import type { Theme, Width } from './prefs';

export async function getViewPrefs(): Promise<{ theme: Theme; width: Width }> {
  const store = await cookies();
  return {
    theme: readTheme(store.get(THEME_COOKIE)?.value),
    width: readWidth(store.get(WIDTH_COOKIE)?.value),
  };
}
