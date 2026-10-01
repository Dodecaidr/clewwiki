/**
 * How a reader likes the interface drawn: colour theme and page width.
 *
 * Both live in cookies rather than in the account, so the choice applies
 * before sign-in, differs per device, and is known to the server when it
 * renders — no flash of the wrong theme while a script catches up.
 */
export const THEME_COOKIE = 'clewwiki-theme';
export const WIDTH_COOKIE = 'clewwiki-width';

export const themes = ['system', 'light', 'dark'] as const;
export type Theme = (typeof themes)[number];

export const widths = ['wide', 'narrow'] as const;
export type Width = (typeof widths)[number];

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (themes as readonly string[]).includes(value);
}

export function isWidth(value: unknown): value is Width {
  return typeof value === 'string' && (widths as readonly string[]).includes(value);
}

export function readTheme(value: string | undefined): Theme {
  return isTheme(value) ? value : 'system';
}

/** Wide by default: on a large monitor the narrow column wasted most of the screen. */
export function readWidth(value: string | undefined): Width {
  return isWidth(value) ? value : 'wide';
}

/** Max width of the page shell, header and footer included. */
export function shellWidthClass(width: Width): string {
  return width === 'wide' ? 'max-w-[110rem]' : 'max-w-5xl';
}

/**
 * Whether the page is drawn dark right now — the explicit choice on `<html>`
 * first, the system preference only when the reader left it to the system.
 * For client code that has to pick a palette itself (Mermaid).
 */
export function isDarkNow(): boolean {
  if (typeof window === 'undefined') return false;
  const chosen = document.documentElement.dataset.theme;
  if (chosen === 'dark') return true;
  if (chosen === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
