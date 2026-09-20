import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * A viewer reads and does not write. Over REST that is one decision, made in
 * `requireScopes`. In server actions it is a convention — ask for the session
 * with `getWriterSession` — and a convention that decides who may change a page
 * is worth a test that fails when a new action forgets it.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app');

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return filesUnder(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

const actionFiles = filesUnder(root).filter((file) => /^'use server';/.test(readFileSync(file, 'utf8')));
const relative = (file: string): string => path.relative(root, file);

/**
 * Actions a viewer is meant to reach, and why. Everything else must not see a
 * viewer's session at all.
 */
const OPEN_TO_VIEWERS: Record<string, string> = {
  'actions.ts': 'signing out',
  'login/actions.ts': 'signing in: there is no session yet',
  'setup/actions.ts': 'first-run setup: there is no account yet',
  'join/[token]/actions.ts': 'accepting an invitation: there is no session yet',
  'reset/[token]/actions.ts': 'using a reset link: there is no session',
  'inbox/actions.ts': "marking one's own inbox read",
  'settings/account/actions.ts': "one's own name and password",
  'settings/members/actions.ts': 'administrators only, checked by role in every action',
  'tokens/actions.ts': 'administrators only, checked by role in every action',
};

describe('server actions and the viewer role', () => {
  it('has something to check', () => {
    expect(actionFiles.length).toBeGreaterThanOrEqual(15);
  });

  it('never hands a content-changing action a viewer session', () => {
    const offenders = actionFiles
      .filter((file) => !(relative(file) in OPEN_TO_VIEWERS))
      .filter((file) => /\bgetSessionContext\b/.test(readFileSync(file, 'utf8')))
      .map(relative);
    expect(offenders).toEqual([]);
  });

  it('asks for a writer wherever it asks for anybody', () => {
    const silent = actionFiles
      .filter((file) => !(relative(file) in OPEN_TO_VIEWERS))
      .filter((file) => !/\bgetWriterSession\b/.test(readFileSync(file, 'utf8')))
      .map(relative);
    expect(silent).toEqual([]);
  });

  it('keeps the exceptions honest: the administrator-only ones check the role', () => {
    for (const name of ['settings/members/actions.ts', 'tokens/actions.ts']) {
      const source = readFileSync(path.join(root, name), 'utf8');
      const actions = source.match(/export async function \w+Action\b/g) ?? [];
      const checks = source.match(/role !== 'admin'|role === 'admin'|requireAdmin\(\)/g) ?? [];
      expect(checks.length, name).toBeGreaterThanOrEqual(actions.length);
    }
  });

  it('lists no exception that no longer exists', () => {
    const known = new Set(actionFiles.map(relative));
    expect(Object.keys(OPEN_TO_VIEWERS).filter((name) => !known.has(name))).toEqual([]);
  });
});
