import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Compose class names; later Tailwind utilities win over earlier ones. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * The slice of next-intl's formatter that date rendering needs. Taking it as an
 * argument keeps the active locale and time zone in one place — the request
 * config — instead of a formatter pinned to one language here.
 */
export interface DateTimeFormatter {
  dateTime(value: Date, options: { dateStyle: 'medium'; timeStyle: 'short' }): string;
}

export function formatDateTime(
  format: DateTimeFormatter,
  value: Date | string | null | undefined,
): string | null {
  if (!value) return null;
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
  return format.dateTime(date, { dateStyle: 'medium', timeStyle: 'short' });
}
