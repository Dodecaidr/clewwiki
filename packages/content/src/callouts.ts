/**
 * Callouts, stored as GitHub's alert syntax:
 *
 *     > [!WARNING]
 *     > Deleting a page removes its whole subtree.
 *
 * A plain blockquote whose first line is the marker. Nothing about it needs
 * validating — a marker that is not one of these kinds is just a quote — so
 * this module only names the kinds and recognises the marker.
 */

export const CALLOUT_KINDS = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

/**
 * The four kinds the editor offers, by what a writer means. `IMPORTANT` is
 * rendered when a page uses it but not offered, so the menu stays short.
 */
export const EDITOR_CALLOUTS: ReadonlyArray<{ tone: 'info' | 'success' | 'warning' | 'danger'; kind: CalloutKind }> = [
  { tone: 'info', kind: 'NOTE' },
  { tone: 'success', kind: 'TIP' },
  { tone: 'warning', kind: 'WARNING' },
  { tone: 'danger', kind: 'CAUTION' },
];

/** Default English titles, used where no translated label is supplied. */
export const CALLOUT_TITLES: Record<CalloutKind, string> = {
  NOTE: 'Note',
  TIP: 'Tip',
  IMPORTANT: 'Important',
  WARNING: 'Warning',
  CAUTION: 'Caution',
};

/**
 * The marker at the very start of a blockquote's first paragraph, as GitHub
 * reads it: the kind in any case, then the end of the line.
 */
export const CALLOUT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i;

export function calloutKindOf(firstLine: string): CalloutKind | null {
  const match = CALLOUT_MARKER.exec(firstLine);
  return match?.[1] ? (match[1].toUpperCase() as CalloutKind) : null;
}
