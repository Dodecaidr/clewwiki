'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';

import { revokeAgentTokenAction } from './actions';
import type { TokenFormState } from './actions';
import { Button } from '@/components/ui/button';

const initialState: TokenFormState = {};

export function RevokeButton({ tokenId, tokenName }: { tokenId: string; tokenName: string }) {
  const t = useTranslations('tokens');
  const [, action, pending] = useActionState(revokeAgentTokenAction, initialState);

  return (
    <form action={action}>
      <input type="hidden" name="tokenId" value={tokenId} />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={pending}
        aria-label={`${t('revoke')} — ${tokenName}`}
      >
        {t('revoke')}
      </Button>
    </form>
  );
}
