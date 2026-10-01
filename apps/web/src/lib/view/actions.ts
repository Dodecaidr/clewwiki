'use server';

import { cookies } from 'next/headers';

import { THEME_COOKIE, WIDTH_COOKIE, isTheme, isWidth } from './prefs';

const cookieOptions = {
  path: '/',
  maxAge: 60 * 60 * 24 * 365,
  sameSite: 'lax' as const,
  httpOnly: true,
};

/** Only the values the switcher offers are ever stored. */
export async function setThemeAction(theme: string): Promise<void> {
  if (!isTheme(theme)) return;
  (await cookies()).set(THEME_COOKIE, theme, cookieOptions);
}

export async function setWidthAction(width: string): Promise<void> {
  if (!isWidth(width)) return;
  (await cookies()).set(WIDTH_COOKIE, width, cookieOptions);
}
