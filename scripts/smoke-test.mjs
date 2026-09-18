#!/usr/bin/env node
/**
 * End-to-end smoke test for a freshly started, empty clewwiki instance.
 *
 * It does what a new operator does after `docker compose up`, over HTTP only,
 * through the same requests a browser and an agent send:
 *
 *   1. waits for /api/v1/health to report the database up;
 *   2. checks the public sign-up route is closed, submits the first-run /setup
 *      form with a wrong setup token (refused) and then the right one, and
 *      checks /setup has become a 404;
 *   3. signs in through the /login form, creates a space through the
 *      /spaces/new form, and issues an agent token through the /tokens form,
 *      reading the one-time secret out of the rendered page;
 *   4. with that token: /api/v1/me, the space list, create a page in the space,
 *      claim it, write it under the claim, release the claim, export it as
 *      Markdown and as HTML, and export the whole space as a ZIP;
 *   5. MCP over streamable HTTP: initialize, then tools/list must name twenty-two
 *      tools (requires MCP_HTTP_ENABLED=true on the instance).
 *
 * The forms are submitted the way a browser without JavaScript submits them:
 * the page is fetched, every hidden field React rendered into the form is sent
 * back unchanged alongside the visible fields, as multipart form data, with the
 * instance's own Origin. There is no test-only endpoint and no seeded account —
 * if this passes, the path a person follows works.
 *
 * It needs Node 22 and nothing else. It must run against an instance with no
 * accounts yet, and it leaves one behind: point it at a throwaway instance.
 *
 *   SMOKE_BASE_URL=http://127.0.0.1:3000 SMOKE_SETUP_TOKEN=… node scripts/smoke-test.mjs
 *
 * The setup token is the instance's CLEWWIKI_SETUP_TOKEN. When neither
 * SMOKE_SETUP_TOKEN nor CLEWWIKI_SETUP_TOKEN is set, the script reads the
 * generated token out of `docker compose logs web`, the way the README tells
 * an operator to.
 *
 * Exit status is 0 when every step passed and 1 at the first failure.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const BASE_URL = (process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const ORIGIN = new URL(BASE_URL).origin;
const HEALTH_TIMEOUT_MS = Number.parseInt(process.env.SMOKE_HEALTH_TIMEOUT_SECONDS ?? '180', 10) * 1000;
const EXPECTED_MCP_TOOLS = 22;
const SPACE_KEY = 'SMOKE';

const admin = {
  workspaceName: 'Smoke test',
  name: 'Smoke Admin',
  email: `smoke-${randomBytes(4).toString('hex')}@example.com`,
  // Generated per run and never printed.
  password: randomBytes(24).toString('base64url'),
};

let step = 0;

function log(message) {
  console.log(`[smoke] ${message}`);
}

function pass(message) {
  step += 1;
  console.log(`[smoke] ok ${step} - ${message}`);
}

class SmokeFailure extends Error {}

function fail(message) {
  throw new SmokeFailure(message);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A cookie jar just big enough for one signed-in browser. */
const cookies = new Map();

function storeCookies(response) {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (value === '' || /max-age=0/i.test(header)) cookies.delete(name);
    else cookies.set(name, value);
  }
}

function cookieHeader() {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function browserFetch(path, init = {}) {
  const headers = new Headers(init.headers);
  if (cookies.size > 0) headers.set('cookie', cookieHeader());
  headers.set('accept', 'text/html');
  const response = await fetch(`${BASE_URL}${path}`, { ...init, headers, redirect: 'manual' });
  storeCookies(response);
  return response;
}

function decodeEntities(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function attribute(tag, name) {
  const match = new RegExp(`\\s${name.replace(/[$]/g, '\\$')}="([^"]*)"`).exec(tag);
  return match ? decodeEntities(match[1]) : null;
}

/**
 * Returns the hidden inputs of the first form on the page that contains a
 * field named `marker`. These carry the server action reference and its bound
 * state; a browser sends them back verbatim, and so does this.
 */
function hiddenFieldsOfForm(html, marker) {
  const forms = html.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
  const form = forms.find((candidate) => candidate.includes(`name="${marker}"`));
  if (!form) fail(`no form with a "${marker}" field on the page`);
  const fields = [];
  for (const tag of form.match(/<input\b[^>]*>/g) ?? []) {
    if (attribute(tag, 'type') !== 'hidden') continue;
    const name = attribute(tag, 'name');
    if (name) fields.push([name, attribute(tag, 'value') ?? '']);
  }
  expect(
    fields.some(([name]) => name.startsWith('$ACTION')),
    `the "${marker}" form carries no server action reference`,
  );
  return fields;
}

async function submitForm(path, marker, values) {
  const page = await browserFetch(path);
  expect(page.status === 200, `GET ${path} answered ${page.status}, expected 200`);
  const html = await page.text();

  const body = new FormData();
  for (const [name, value] of hiddenFieldsOfForm(html, marker)) body.append(name, value);
  for (const [name, value] of values) body.append(name, value);

  return browserFetch(path, { method: 'POST', body, headers: { origin: ORIGIN } });
}

async function api(method, path, token, body) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    // Exports are not JSON; callers that expect text read `text`.
  }
  return { status: response.status, headers: response.headers, text, json };
}

function describe(result) {
  return `${result.status} ${result.text.slice(0, 300)}`;
}

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = 'no answer yet';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/api/v1/health`);
      const body = await response.json();
      if (response.status === 200 && body.status === 'ok' && body.database === 'up') {
        pass('health reports ok with the database up');
        return;
      }
      last = `${response.status} ${JSON.stringify(body)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(2000);
  }
  fail(`health did not report ok within ${HEALTH_TIMEOUT_MS / 1000}s (last: ${last})`);
}

/** The one-time setup token: from the environment, or from the container log. */
function readSetupToken() {
  const configured = (process.env.SMOKE_SETUP_TOKEN ?? process.env.CLEWWIKI_SETUP_TOKEN ?? '').trim();
  if (configured !== '') return configured;
  let logs = '';
  try {
    logs = execFileSync('docker', ['compose', 'logs', '--no-color', 'web'], { encoding: 'utf8' });
  } catch (error) {
    fail(`no SMOKE_SETUP_TOKEN given and the container log could not be read: ${error.message}`);
  }
  const lines = logs.split('\n').filter((line) => line.includes('setup token:'));
  const match = /setup token: (\S+)/.exec(lines.at(-1) ?? '');
  expect(match, 'no SMOKE_SETUP_TOKEN given and no "setup token" line in docker compose logs web');
  return match[1];
}

async function signUpIsClosed() {
  const response = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email: `self-${admin.email}`, password: randomBytes(18).toString('base64url'), name: 'Self' }),
  });
  expect(response.status === 404, `POST /api/auth/sign-up/email answered ${response.status}, expected 404`);
  pass('the public sign-up route is closed');
}

async function firstRunSetup() {
  const refused = await submitForm('/setup', 'workspaceName', [
    ['setupToken', `wrong-${randomBytes(8).toString('hex')}`],
    ['workspaceName', admin.workspaceName],
    ['name', admin.name],
    ['email', admin.email],
    ['password', admin.password],
  ]);
  expect(
    !(refused.status >= 300 && refused.status < 400),
    `setup with a wrong token answered ${refused.status} (location "${refused.headers.get('location')}"), expected no redirect`,
  );
  const stillOpen = await browserFetch('/setup');
  expect(stillOpen.status === 200, `/setup answered ${stillOpen.status} after a refused attempt, expected 200`);
  pass('setup refuses a wrong setup token');

  const response = await submitForm('/setup', 'workspaceName', [
    ['setupToken', readSetupToken()],
    ['workspaceName', admin.workspaceName],
    ['name', admin.name],
    ['email', admin.email],
    ['password', admin.password],
  ]);
  const location = response.headers.get('location') ?? '';
  expect(
    response.status >= 300 && response.status < 400 && location.endsWith('/login'),
    `setup form answered ${response.status} (location "${location}"), expected a redirect to /login`,
  );
  pass('first-run setup created the administrator and the workspace');

  const again = await browserFetch('/setup');
  expect(again.status === 404, `/setup answered ${again.status} after setup, expected 404`);
  pass('/setup answers 404 once an account exists');
}

async function signIn() {
  // Setup may leave its own session behind. Sign in from a clean jar, the way a
  // second browser would, so the login form itself is what is being tested.
  cookies.clear();
  const response = await submitForm('/login', 'password', [
    ['email', admin.email],
    ['password', admin.password],
  ]);
  const location = response.headers.get('location') ?? '';
  expect(
    response.status >= 300 && response.status < 400 && !location.includes('/login'),
    `login form answered ${response.status} (location "${location}"), expected a redirect away from /login`,
  );
  expect(cookies.size > 0, 'login set no session cookie');
  pass('signed in through the login form');
}

async function createSpace() {
  const response = await submitForm('/spaces/new', 'key', [
    ['name', 'Smoke test space'],
    ['key', SPACE_KEY],
    ['icon', ''],
    ['description', 'Created by the container smoke test.'],
  ]);
  const location = response.headers.get('location') ?? '';
  expect(
    response.status >= 300 && response.status < 400 && location.endsWith(`/spaces/${SPACE_KEY}`),
    `space form answered ${response.status} (location "${location}"), expected a redirect to /spaces/${SPACE_KEY}`,
  );
  const overview = await browserFetch(`/spaces/${SPACE_KEY}`);
  expect(overview.status === 200, `GET /spaces/${SPACE_KEY} answered ${overview.status}, expected 200`);
  pass('created a space through the space form');
}

async function issueToken() {
  const response = await submitForm('/tokens', 'expiresInDays', [
    ['name', 'smoke-test'],
    ['expiresInDays', '7'],
    ['scopes', 'identity:read'],
    ['scopes', 'pages:read'],
    ['scopes', 'pages:write'],
  ]);
  expect(response.status === 200, `token form answered ${response.status}, expected 200`);
  const html = await response.text();
  const match = /cww_[A-Za-z0-9_-]{6,32}\.[A-Za-z0-9_-]{16,128}/.exec(html);
  expect(match, 'the token form response did not show a token');
  pass('issued an agent token through the tokens form');
  return match[0];
}

async function wikiRoundTrip(token) {
  const me = await api('GET', '/api/v1/me', token);
  expect(me.status === 200, `GET /api/v1/me: ${describe(me)}`);
  expect(me.json?.actor?.type === 'agent', `GET /api/v1/me did not identify an agent: ${me.text}`);
  pass('GET /api/v1/me answers 200 for the agent token');

  const spaces = await api('GET', '/api/v1/spaces', token);
  expect(spaces.status === 200, `GET /api/v1/spaces: ${describe(spaces)}`);
  expect(
    Array.isArray(spaces.json?.spaces) && spaces.json.spaces.some((space) => space.key === SPACE_KEY),
    `GET /api/v1/spaces does not list ${SPACE_KEY}: ${spaces.text}`,
  );
  pass('GET /api/v1/spaces lists the new space');

  const suffix = randomBytes(3).toString('hex');
  const created = await api('POST', '/api/v1/pages', token, {
    space: SPACE_KEY,
    title: `Smoke ${suffix}`,
    path: `/smoke-${suffix}`,
    kind: 'technical',
    summary: 'Created by the container smoke test.',
    body: '# Smoke\n\nFirst version.\n',
  });
  expect(created.status === 201 || created.status === 200, `create page: ${describe(created)}`);
  const pageId = created.json?.page_id;
  expect(typeof pageId === 'string', `create page returned no page_id: ${created.text}`);
  pass('created a page');

  const claimed = await api('POST', `/api/v1/pages/${pageId}/claims`, token, { ttl_seconds: 120 });
  expect(claimed.status === 201, `claim page: ${describe(claimed)}`);
  const claimId = claimed.json?.claim_id;
  const baseHash = claimed.json?.base_content_hash;
  expect(typeof claimId === 'string' && typeof baseHash === 'string', `claim returned ${claimed.text}`);
  pass('claimed the page');

  const marker = `Written under claim ${suffix}.`;
  const written = await api('PATCH', `/api/v1/pages/${pageId}`, token, {
    body: `# Smoke\n\n${marker}\n\n\`\`\`mermaid\nflowchart LR\n  Agent --> Page\n\`\`\`\n`,
    claim_id: claimId,
    base_content_hash: baseHash,
  });
  expect(written.status === 200, `write page: ${describe(written)}`);
  expect(written.json?.version === 2, `write did not bump the version: ${written.text}`);
  pass('wrote the page under the claim');

  const released = await api('DELETE', `/api/v1/claims/${claimId}`, token);
  expect(released.status >= 200 && released.status < 300, `release claim: ${describe(released)}`);
  const claims = await api('GET', `/api/v1/pages/${pageId}/claims`, token);
  expect(claims.status === 200, `list claims: ${describe(claims)}`);
  expect(!claims.text.includes(claimId), `the released claim is still listed: ${claims.text}`);
  pass('released the claim');

  const md = await api('GET', `/api/v1/export/${pageId}?format=md`, token);
  expect(md.status === 200, `export md: ${describe(md)}`);
  expect((md.headers.get('content-type') ?? '').startsWith('text/markdown'), 'md export content type');
  expect(md.text.startsWith('---\n') && md.text.includes(marker), 'md export lacks front matter or body');
  pass('exported the page as Markdown');

  const html = await api('GET', `/api/v1/export/${pageId}?format=html`, token);
  expect(html.status === 200, `export html: ${describe(html)}`);
  expect((html.headers.get('content-type') ?? '').startsWith('text/html'), 'html export content type');
  expect(html.text.startsWith('<!doctype html>'), 'html export is not a standalone document');
  expect(html.text.includes(marker), 'html export lacks the written body');
  expect(html.text.includes('@media print'), 'html export carries no print stylesheet');
  pass('exported the page as HTML');

  const zip = await fetch(`${BASE_URL}/api/v1/spaces/${SPACE_KEY}/export?format=md`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const archive = Buffer.from(await zip.arrayBuffer());
  expect(zip.status === 200, `export space: ${zip.status}`);
  expect((zip.headers.get('content-type') ?? '') === 'application/zip', 'space export content type');
  expect(
    archive.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) &&
      archive.includes(Buffer.from(`${SPACE_KEY}/smoke-${suffix}.md`)),
    'space export is not a ZIP holding the page',
  );
  pass('exported the space as a ZIP of Markdown');
}

async function mcp(token, id, method, params) {
  const response = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await response.text();
  let payload = null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('');
    payload = data === '' ? null : JSON.parse(data);
  } else if (text !== '') {
    payload = JSON.parse(text);
  }
  return { status: response.status, text, payload };
}

async function mcpOverHttp(token) {
  const initialized = await mcp(token, 1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'clewwiki-smoke-test', version: '1.0.0' },
  });
  expect(
    initialized.status === 200 && initialized.payload?.result?.serverInfo,
    `MCP initialize: ${initialized.status} ${initialized.text.slice(0, 300)} (is MCP_HTTP_ENABLED=true set?)`,
  );
  pass('MCP initialize over streamable HTTP');

  const listed = await mcp(token, 2, 'tools/list', {});
  const tools = listed.payload?.result?.tools;
  expect(listed.status === 200 && Array.isArray(tools), `MCP tools/list: ${listed.status} ${listed.text.slice(0, 300)}`);
  expect(
    tools.length === EXPECTED_MCP_TOOLS,
    `MCP tools/list returned ${tools.length} tools, expected ${EXPECTED_MCP_TOOLS}: ${tools.map((tool) => tool.name).join(', ')}`,
  );
  pass(`MCP tools/list returns ${EXPECTED_MCP_TOOLS} tools`);
}

async function main() {
  log(`target ${BASE_URL}`);
  await waitForHealth();
  await signUpIsClosed();
  await firstRunSetup();
  await signIn();
  await createSpace();
  const token = await issueToken();
  await wikiRoundTrip(token);
  await mcpOverHttp(token);
  log(`all ${step} checks passed`);
}

main().catch((error) => {
  if (error instanceof SmokeFailure) {
    console.error(`[smoke] not ok ${step + 1} - ${error.message}`);
  } else {
    console.error('[smoke] unexpected error', error);
  }
  process.exit(1);
});
