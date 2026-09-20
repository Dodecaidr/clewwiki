#!/usr/bin/env node
/**
 * Checks the published MCP package the way an agent host uses it: start
 * `npx -y @clewwiki/mcp-server` as a child process, speak MCP over its stdio,
 * and expect `initialize` and `tools/list` to answer.
 *
 *   CLEWWIKI_URL=http://127.0.0.1:3000 CLEWWIKI_TOKEN=cww_… node scripts/mcp-stdio-check.mjs
 *
 * MCP_PACKAGE overrides the package spec (default `@clewwiki/mcp-server`, the
 * latest published version). It needs Node 22 and network access to the npm
 * registry. Exit status is 0 when both calls answered and 1 otherwise.
 */
import { spawn } from 'node:child_process';

const PACKAGE = process.env.MCP_PACKAGE ?? '@clewwiki/mcp-server';
const TIMEOUT_MS = Number.parseInt(process.env.MCP_CHECK_TIMEOUT_SECONDS ?? '120', 10) * 1000;

for (const name of ['CLEWWIKI_URL', 'CLEWWIKI_TOKEN']) {
  if ((process.env[name] ?? '').trim() === '') {
    console.error(`[mcp-stdio] ${name} is not set`);
    process.exit(1);
  }
}

const child = spawn('npx', ['-y', PACKAGE], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
const pending = new Map();
let buffer = '';

function finish(code, message) {
  console.error(`[mcp-stdio] ${message}`);
  child.kill();
  process.exit(code);
}

const timer = setTimeout(() => finish(1, `no answer within ${TIMEOUT_MS / 1000}s`), TIMEOUT_MS);

child.on('error', (error) => finish(1, `could not start npx: ${error.message}`));
child.on('exit', (code) => {
  if (pending.size > 0) finish(1, `the server exited with status ${code} before answering`);
});

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (line === '') continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      finish(1, `a line on stdout is not JSON: ${line.slice(0, 200)}`);
    }
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  }
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(id, method, params) {
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}

const initialized = await request(1, 'initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'clewwiki-install-check', version: '1.0.0' },
});
if (!initialized.result?.serverInfo) finish(1, `initialize failed: ${JSON.stringify(initialized).slice(0, 300)}`);
console.error(`[mcp-stdio] ok - initialize answered as ${initialized.result.serverInfo.name} ${initialized.result.serverInfo.version}`);
send({ jsonrpc: '2.0', method: 'notifications/initialized' });

const listed = await request(2, 'tools/list', {});
const tools = listed.result?.tools;
if (!Array.isArray(tools) || tools.length === 0) finish(1, `tools/list failed: ${JSON.stringify(listed).slice(0, 300)}`);
console.error(`[mcp-stdio] ok - tools/list returned ${tools.length} tools`);

const spaces = await request(3, 'tools/call', { name: 'wiki.list_spaces', arguments: {} });
if (!spaces.result || spaces.result.isError) finish(1, `wiki.list_spaces failed: ${JSON.stringify(spaces).slice(0, 300)}`);
console.error('[mcp-stdio] ok - wiki.list_spaces reached the instance');

clearTimeout(timer);
finish(0, 'all checks passed');
