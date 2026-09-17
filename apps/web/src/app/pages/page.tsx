import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** The page list moved into the spaces; the space list is the new start. */
export default function LegacyPagesIndex(): never {
  redirect('/');
}
