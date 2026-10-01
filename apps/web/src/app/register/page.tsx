import { redirect } from 'next/navigation';

import { DEFAULT_WORKSPACE_SLUG } from '@/lib/workspace';

/** `/register` asks to join the organization made at setup. */
export default function RegisterPage(): never {
  redirect(`/o/${DEFAULT_WORKSPACE_SLUG}/register`);
}
