import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const preload = `
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const file = process.env.PROBE_QUESTIONS;
const questions = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
globalThis.fetch = async (raw, init) => {
  const url = new URL(raw);
  if (url.origin !== 'https://api.pingroom.io') throw new Error('Unexpected origin');
  if (init.method === 'GET' && url.pathname === '/api/agent/rooms') return Response.json([{ invite_code: 'DEMO12345678', type: 'standard', is_public: false, members: [{ user_id: '11111111-1111-4111-8111-111111111111' }] }]);
  if (init.method === 'POST' && url.pathname === '/api/agent/rooms/DEMO12345678/questions') {
    const body = JSON.parse(init.body), now = new Date().toISOString();
    const id = '01990000-0000-7000-8000-' + String(Object.keys(questions).length + 1).padStart(12, '0');
    const q = { ...body, id, kind: 'question', is_handoff: false, resolution_policy: 'first', room_code: 'DEMO12345678', room: { code: 'DEMO12345678' },
      asker: { type: 'agent', id: '33333333-3333-4333-8333-333333333333' }, text_input: null, results: null,
      options: body.options.map(({ value, label }) => ({ value, label, primary: false, destructive: false })),
      state: 'pending', created_at: now, expires_at: new Date(Date.parse(now) + 900000).toISOString(), resolved_at: null, answer: null, reply_to: null };
    questions[id] = q; writeFileSync(file, JSON.stringify(questions));
    if (process.env.PROBE_LOST === 'yes') throw new Error('Lost creation response');
    return Response.json(q, { status: 201 });
  }
  if (init.method === 'GET' && url.pathname === '/api/agent/questions') return Response.json({questions:Object.values(questions)});
  if (init.method === 'GET' && url.pathname.startsWith('/api/agent/questions/')) {
    const q = questions[url.pathname.split('/').at(-1)];
    if (!q) throw new Error('Unexpected Question');
    if (process.env.PROBE_ANSWER === 'required' || process.env.PROBE_ANSWER === 'unknown') {
      q.state = 'answered'; q.resolved_at = new Date().toISOString();
      q.answer = { value: process.env.PROBE_ANSWER, label: process.env.PROBE_ANSWER === 'unknown' ? 'Unknown' : 'Required', text: null, responder: { id: q.target_user_id }, answered_at: q.resolved_at };
    } else if (process.env.PROBE_ANSWER === 'cancelled') { q.state = 'cancelled'; q.resolved_at = new Date().toISOString(); }
    writeFileSync(file, JSON.stringify(questions)); return Response.json(q);
  }
  throw new Error('Unexpected mocked request');
};
`;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'route-cli-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(source, 'src'), join(directory, 'src'), { recursive: true });
  await cp(join(source, 'package.json'), join(directory, 'package.json'));
  await cp(join(source, 'config.example.json'), join(directory, 'config.json'));
  await symlink(join(source, 'node_modules'), join(directory, 'node_modules'));
  await writeFile(join(directory, 'preload.mjs'), preload);
  await writeFile(join(directory, 'route.json'), JSON.stringify({ routeId: 'cli', title: 'Fixture', costUnit: 'minutes', depot: {id:'depot', label:'Depot'}, stops: ['a','b'].map(id=>({id,label:id,details:'Example stop'})), travel:{ids:['depot','a','b'],costs:[[0,1,4],[4,0,1],[1,4,0]]} }));
  return directory;
}
function run(directory, extra = {}, args = ['run']) {
  const env = { ...process.env, PINGROOM_TOKEN: 'offline-fixture', PINGROOM_ROOM: 'DEMO12345678', PROBE_QUESTIONS: join(directory, 'questions.json'), ...extra };
  delete env.NODE_OPTIONS;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', join(directory, 'preload.mjs'), join(directory, 'src/cli.js'), ...args], { cwd: tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
test('CLI distinguishes pending, ready and complete when launched from another directory', async t => {
  const directory = await fixture(t);
  for (const [env, expectedCode, expectedStatus] of [[{}, 3, 'pending'], [{ PROBE_ANSWER: 'required' }, 3, 'ready'], [{}, 3, 'pending'], [{ PROBE_ANSWER: 'required' }, 0, 'complete']]) {
    const result = await run(directory, env);
    assert.equal(result.code, expectedCode, result.stderr); assert.equal(JSON.parse(result.stdout).status, expectedStatus);
  }
});
test('CLI returns uncertain creation and cancelled-observation codes without confusing ready with success', async t => {
  const unknown = await fixture(t); const first = await run(unknown, { PROBE_LOST: 'yes' });
  assert.equal(first.code, 4); assert.equal(JSON.parse(first.stdout).status, 'create_unknown');
  assert.equal((await run(unknown)).code, 4);
  const cancelled = await fixture(t); await run(cancelled);
  const result = await run(cancelled, { PROBE_ANSWER: 'cancelled' });
  assert.equal(result.code, 2, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'ready');
});

test('CLI returns incomplete for Unknown after collecting the remaining item', async t => {
  const directory = await fixture(t); assert.equal((await run(directory)).code,3);
  const unknown = await run(directory,{PROBE_ANSWER:'unknown'}); assert.equal(unknown.code,3,unknown.stderr); assert.equal(JSON.parse(unknown.stdout).route,null);
  assert.equal((await run(directory)).code,3);
  const result = await run(directory,{PROBE_ANSWER:'required'}); assert.equal(result.code,2,result.stderr);
  assert.equal(JSON.parse(result.stdout).status,'incomplete'); assert.equal(JSON.parse(result.stdout).route,null);
});

test('CLI finds and recovers an uncertain exact Question without a second creation', async t => {
  const directory=await fixture(t); assert.equal((await run(directory,{PROBE_LOST:'yes'})).code,4);
  const found=await run(directory,{},['find']); const candidates=JSON.parse(found.stdout).candidates;
  assert.equal(candidates.length,1); const questionId=candidates[0].id;
  const recovered=await run(directory,{},['recover',questionId]); assert.equal(recovered.code,3,recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).choices[0].questionId,questionId);
});

test('CLI returns infeasible code when all required choices lack a closed tour', async t => {
  const directory=await fixture(t);
  await writeFile(join(directory,'route.json'),JSON.stringify({routeId:'no-route',title:'Unreachable',costUnit:'minutes',depot:{id:'d',label:'Depot'},stops:[{id:'a',label:'A',details:'Visit A'}],travel:{ids:['d','a'],costs:[[0,1],[null,0]]}}));
  assert.equal((await run(directory)).code,3);
  const result=await run(directory,{PROBE_ANSWER:'required'}); assert.equal(result.code,2,result.stderr);
  assert.equal(JSON.parse(result.stdout).status,'infeasible'); assert.equal(JSON.parse(result.stdout).route.tour,null);
});
