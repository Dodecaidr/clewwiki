import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { getDatabase } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Unauthenticated liveness/readiness probe, used by the compose healthcheck.
 *
 * It reports only whether the process and its database are reachable. No
 * version of the schema, no configuration and no counts are exposed, because
 * this is the one endpoint an operator may leave open by accident.
 */
export async function GET() {
  let database: 'up' | 'down' = 'down';
  try {
    await getDatabase().execute(sql`select 1`);
    database = 'up';
  } catch {
    database = 'down';
  }

  const healthy = database === 'up';
  return NextResponse.json(
    { status: healthy ? 'ok' : 'degraded', service: 'clewwiki', database },
    { status: healthy ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
