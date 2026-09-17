import { z } from 'zod';

/**
 * Space keys and the shape of a space's editable fields.
 *
 * Pure on purpose — no database, no framework — so the rules can be unit-tested
 * and shared by the REST handlers, the server actions and the forms.
 */

/**
 * 2–10 uppercase ASCII letters or digits. The same pattern is a CHECK
 * constraint on `spaces.key`, so nothing that bypasses this module can store a
 * key the URLs and the agent prompts could not carry.
 */
export const SPACE_KEY_PATTERN = /^[A-Z0-9]{2,10}$/;

export const MAX_SPACE_NAME_LENGTH = 100;
export const MAX_SPACE_DESCRIPTION_LENGTH = 2_000;
export const MAX_SPACE_ICON_LENGTH = 16;

/**
 * The canonical form of a key a caller typed: trimmed and uppercased. Lookups
 * accept `mobile` for `MOBILE`; storage only ever holds the uppercase form.
 */
export function normalizeSpaceKey(value: string): string {
  return value.trim().toUpperCase();
}

export function isSpaceKey(value: string): boolean {
  return SPACE_KEY_PATTERN.test(value);
}

/** Why a proposed key is refused, or null when it is acceptable. */
export function spaceKeyProblem(value: string): string | null {
  const key = normalizeSpaceKey(value);
  if (key.length < 2 || key.length > 10) return 'A space key is 2 to 10 characters long';
  if (!SPACE_KEY_PATTERN.test(key)) return 'A space key uses only the letters A–Z and the digits 0–9';
  return null;
}

/**
 * A key as it arrives in a URL or a query string. Normalised first, then held
 * to the pattern, so an invalid key is simply "not found" rather than a query.
 */
export const spaceKeyParamSchema = z
  .string()
  .transform(normalizeSpaceKey)
  .refine(isSpaceKey, 'Unknown space key');

export const spaceKeyInputSchema = z
  .string()
  .superRefine((value, context) => {
    const problem = spaceKeyProblem(value);
    if (problem !== null) context.addIssue({ code: 'custom', message: problem });
  })
  .transform(normalizeSpaceKey);

export const spaceNameSchema = z.string().trim().min(1).max(MAX_SPACE_NAME_LENGTH);
export const spaceDescriptionSchema = z.string().trim().max(MAX_SPACE_DESCRIPTION_LENGTH);

/** An icon is short display text: an emoji, or two or three letters. Empty clears it. */
export const spaceIconSchema = z
  .string()
  .trim()
  .max(MAX_SPACE_ICON_LENGTH)
  .transform((value) => (value === '' ? null : value));
