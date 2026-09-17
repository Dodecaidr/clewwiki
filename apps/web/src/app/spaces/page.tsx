import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** The space list lives on the home page. */
export default function SpacesIndex(): never {
  redirect('/');
}
