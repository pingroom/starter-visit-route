import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, symlink, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
// Exercise the real CLI and pinned SDK. No request can reach the network.
const preload = `
import { appendFileSync } from 'node:fs';
globalThis.fetch = async (input, init) => {
  const url = new URL(input), path = url.pathname;
  if (url.origin !== 'https://api.pingroom.io') throw new Error('Unexpected mock origin');
  appendFileSync(process.env.PROBE_LOG, JSON.stringify({ run: process.env.PROBE_RUN, method: init.method, path }) + '\\n');
  if (path === '/api/agent/auth' && init.method === 'POST') {
    return Response.json({ credential: 'offline-pending-token', credential_type: 'pre_claim', expires_in: 900 });
  }
  if (path === '/api/agent/auth/pair/start' && init.method === 'POST') {
    if (process.env.PROBE_LOST === 'yes') throw new Error('Lost pairing response');
    return Response.json({ pair_token: 'offline-token', expires_in: 900, poll_interval_ms: 1000, ...JSON.parse(process.env.PROBE_LINKS) });
  }
  if (path === '/api/agent/auth/pair/status' && init.method === 'GET') {
    if (new Headers(init.headers).get('authorization') !== 'Bearer offline-pending-token') throw new Error('Wrong pending credential');
    return Response.json({ status: 'active', credential: 'offline-approved-token', credential_type: 'active', expires_in: null, home_room: { invite_code: 'MERGEROOM001' } });
  }
  throw new Error('Unexpected mock route');
};
`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'merge-connect-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(source, 'src'), join(directory, 'src'), { recursive: true });
  await cp(join(source, 'package.json'), join(directory, 'package.json'));
  await symlink(join(source, 'node_modules'), join(directory, 'node_modules'));
  await writeFile(join(directory, 'preload.mjs'), preload);
  return directory;
}

function connect(directory, links, { run = 'first', lost = false } = {}) {
  const env = { ...process.env, PROBE_LOG: join(directory, 'requests.jsonl'), PROBE_RUN: run, PROBE_LINKS: JSON.stringify(links), PROBE_LOST: lost ? 'yes' : 'no' };
  for (const key of ['NODE_OPTIONS', 'PINGROOM_TOKEN', 'PINGROOM_ROOM']) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', join(directory, 'preload.mjs'), join(directory, 'src/cli.js'), 'connect'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

const pairingPath = directory => join(directory, '.pingroom', 'pairing.json');
const credentialPath = directory => join(directory, '.pingroom', 'credentials.json');
const requests = async directory => (await readFile(join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);

test('connect accepts the documented API-hosted pair_url when pair_browser_url is absent', async t => {
  const directory = await fixture(t), link = 'https://api.pingroom.io/claim/offline';
  const result = await connect(directory, { pair_url: link });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes(link));
  assert.equal(JSON.parse(await readFile(credentialPath(directory), 'utf8')).token, 'offline-approved-token');
  assert.equal((await stat(credentialPath(directory))).mode & 0o777, 0o600);
  assert.equal((await requests(directory)).filter(call => call.method === 'GET').length, 1);
  await assert.rejects(readFile(pairingPath(directory)), { code: 'ENOENT' });
});

test('connect prefers the browser link and accepts existing pingroom.io pairing links', async t => {
  for (const links of [
    { pair_url: 'https://api.pingroom.io/claim/fallback', pair_browser_url: 'https://pingroom.io/claim/browser' },
    { pair_url: 'https://pingroom.io/claim/legacy' },
    { pair_url: 'https://api.pingroom.io/claim/fallback', pair_browser_url: 'https://api.pingroom.io/claim/browser' },
  ]) {
    const directory = await fixture(t), result = await connect(directory, links);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes(links.pair_browser_url ?? links.pair_url));
    if (links.pair_browser_url) assert.ok(!result.stdout.includes(links.pair_url));
  }
});

test('unsafe pairing links preserve pending state and never poll or create again', async t => {
  for (const link of ['http://api.pingroom.io/claim/offline', 'https://api.pingroom.io.evil.example/claim',
    'https://elsewhere.example/claim', 'https://user:pass@pingroom.io/claim', 'https://api.pingroom.io:444/claim']) {
    for (const field of ['pair_url', 'pair_browser_url']) {
      const directory = await fixture(t);
      const links = { pair_url: 'https://api.pingroom.io/claim/fallback', [field]: link };
      assert.equal((await connect(directory, links)).code, 1);
      const saved = await readFile(pairingPath(directory), 'utf8');
      assert.equal((await connect(directory, {}, { run: 'retry' })).code, 1);
      assert.equal(await readFile(pairingPath(directory), 'utf8'), saved);
      const calls = await requests(directory);
      assert.equal(calls.filter(call => call.method === 'GET' || call.run === 'retry').length, 0);
      await assert.rejects(readFile(credentialPath(directory)), { code: 'ENOENT' });
    }
  }
});

test('lost pairing response still leaves private creation intent without retrying registration', async t => {
  const directory = await fixture(t);
  assert.equal((await connect(directory, {}, { lost: true })).code, 1);
  const saved = await readFile(pairingPath(directory), 'utf8');
  assert.equal(JSON.parse(saved).phase, 'creating');
  assert.equal((await stat(pairingPath(directory))).mode & 0o777, 0o600);
  const result = await connect(directory, { pair_url: 'https://api.pingroom.io/claim/offline' }, { run: 'retry' });
  assert.equal(result.code, 1); assert.match(result.stderr, /uncertain/);
  assert.equal((await requests(directory)).filter(call => call.run === 'retry').length, 0);
  assert.equal(await readFile(pairingPath(directory), 'utf8'), saved);
});
