import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { RevokeButton } from './revoke-button';
import { TokenForm } from './token-form';
import { Alert, Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { listAgentTokens } from '@/lib/agent-tokens';
import { classifyTokenLifecycle } from '@/lib/agent-token-crypto';
import { getSessionContext } from '@/lib/session';
import { listSpaces } from '@/lib/spaces/service';
import { assertSameWorkspace } from '@/lib/workspace';
import { formatDateTime } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('tokens');
  return { title: t('title') };
}

export default async function TokensPage() {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }

  const t = await getTranslations('tokens');
  const format = await getFormatter();
  const isAdmin = session.role === 'admin';
  const [tokens, spaces] = await Promise.all([
    listAgentTokens(session.workspace.id),
    listSpaces(session.workspace.id, { includeArchived: true }),
  ]);
  const spaceKeyById = new Map(spaces.map((space) => [space.id, space.key]));

  // The query already filters by workspace; this re-asserts it on the rows we
  // are about to render, so a future change to the query cannot quietly widen
  // what this page shows.
  for (const token of tokens) {
    assertSameWorkspace(session.workspace.id, token.workspaceId);
  }

  const statusLabel = {
    active: t('statusActive'),
    revoked: t('statusRevoked'),
    expired: t('statusExpired'),
  } as const;

  return (
    <div className="grid gap-8">
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      {isAdmin ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('createHeading')}</CardTitle>
          </CardHeader>
          <CardBody>
            <TokenForm
              spaces={spaces.map((space) => ({ id: space.id, key: space.key, name: space.name }))}
            />
          </CardBody>
        </Card>
      ) : (
        <Alert>{t('adminOnly')}</Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('listHeading')}</CardTitle>
          <CardDescription>{session.workspace.name}</CardDescription>
        </CardHeader>
        <CardBody>
          {tokens.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('listEmpty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">{t('columnName')}</th>
                    <th className="py-2 pr-4 font-medium">{t('columnScopes')}</th>
                    <th className="py-2 pr-4 font-medium">{t('columnSpaces')}</th>
                    <th className="py-2 pr-4 font-medium">{t('columnCreated')}</th>
                    <th className="py-2 pr-4 font-medium">{t('columnExpires')}</th>
                    <th className="py-2 pr-4 font-medium">{t('columnLastUsed')}</th>
                    <th className="py-2 pr-4 font-medium">{t('columnStatus')}</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {tokens.map((token) => {
                    const state = classifyTokenLifecycle(token);
                    return (
                      <tr key={token.id} className="border-b border-border/60 last:border-0">
                        <td className="py-3 pr-4 font-medium">{token.name}</td>
                        <td className="py-3 pr-4 font-mono text-xs text-muted-foreground">
                          {token.scopes.join(', ') || '—'}
                        </td>
                        <td className="py-3 pr-4 font-mono text-xs text-muted-foreground">
                          {token.spaceIds === null
                            ? t('allSpaces')
                            : token.spaceIds
                                .map((id) => spaceKeyById.get(id) ?? '?')
                                .join(', ') || '—'}
                        </td>
                        <td className="py-3 pr-4 text-muted-foreground">
                          {formatDateTime(format, token.createdAt)}
                        </td>
                        <td className="py-3 pr-4 text-muted-foreground">
                          {formatDateTime(format, token.expiresAt) ?? t('never')}
                        </td>
                        <td className="py-3 pr-4 text-muted-foreground">
                          {formatDateTime(format, token.lastUsedAt) ?? t('never')}
                        </td>
                        <td className="py-3 pr-4">{statusLabel[state]}</td>
                        <td className="py-3">
                          {isAdmin && state === 'active' ? (
                            <RevokeButton tokenId={token.id} tokenName={token.name} />
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
