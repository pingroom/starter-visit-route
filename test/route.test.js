import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport } from '../src/engine.js';
import { readJson, atomicJson, acquireLock } from '../src/storage.js';
import { validateInput, validateState, optimizeRoute, requestFor, validateConfig, hash, iso } from '../src/model.js';
import { loadConnection, loadEnvironment } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/route.json', import.meta.url), 65536);
function subset(n) {
  const input = structuredClone(example), ids = [input.depot.id, ...input.stops.slice(0,n).map(stop => stop.id)];
  const indices = ids.map(id => input.travel.ids.indexOf(id));
  input.stops = input.stops.slice(0,n);
  input.travel = { ids, costs: indices.map(i => indices.map(j => input.travel.costs[i][j])) };
  return input;
}
const simple = () => subset(1);
const twoItems = () => subset(2);
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-visit-route-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.choices.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later stop choices; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'required'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options[0].primary = true; }, (q) => { q.options[0].destructive = true; }, (q) => { q.options.reverse(); },
    (q) => { q.data.item_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('wrong, missing, typed or unsupported answers never resolve a stop choice', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = 'required'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'required'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.route, null);
    await s.run(); assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across stop choices', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), 'required'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).status, 'incomplete'); assert.equal((await localReport(s.directory, s.options.input)).route, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'required');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'required'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'required'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing operator before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'required');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'complete'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'required'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).route, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});


function matrix(n, costs) {
  const ids = ['depot', ...Array.from({length:n}, (_,i) => `s${i}`)];
  return {routeId:'fixture', title:'Fixed visits', costUnit:'minutes', depot:{id:'depot',label:'Depot'},
    stops:ids.slice(1).map(id=>({id,label:id,details:'Example visit'})), travel:{ids,costs}};
}
function reorder(input, order) {
  const copy = structuredClone(input), indices = order.map(id=>input.travel.ids.indexOf(id));
  copy.stops.reverse(); copy.travel = {ids:order,costs:indices.map(i=>indices.map(j=>input.travel.costs[i][j]))};
  return copy;
}

// Independent subset dynamic program computes cost, without enumerating tours or calling the optimizer.
function oracle(input, required) {
  const all = input.travel.ids, edge = (a,b) => input.travel.costs[all.indexOf(a)][all.indexOf(b)];
  if (!required.length) return 0;
  const dp = new Map(), n = required.length;
  for (let j=0;j<n;j++) if (edge(input.depot.id,required[j]) !== null) dp.set(`${1<<j},${j}`,edge(input.depot.id,required[j]));
  for (let mask=1;mask<(1<<n);mask++) for(let j=0;j<n;j++) {
    const prior = dp.get(`${mask},${j}`); if(prior === undefined) continue;
    for(let k=0;k<n;k++) if(!(mask & (1<<k))) {
      const cost=edge(required[j],required[k]); if(cost===null) continue;
      const key=`${mask | (1<<k)},${k}`; dp.set(key,Math.min(dp.get(key)??Infinity,prior+cost));
    }
  }
  let best=Infinity;
  for(let j=0;j<n;j++) { const home=edge(required[j],input.depot.id); if(home!==null) best=Math.min(best,(dp.get(`${(1<<n)-1},${j}`)??Infinity)+home); }
  return best===Infinity?null:best;
}

test('directed matrix yields exact asymmetric tour and attributable legs', () => {
  const result=optimizeRoute(example,example.stops.map(s=>s.id));
  assert.deepEqual(result.tour,['depot','library','store','studio','depot']); assert.equal(result.totalCost,12);
  assert.equal(result.legs.reduce((sum,leg)=>sum+leg.cost,0),12); assert.equal(result.costUnit,'minutes');
  assert.equal(optimizeRoute(simple(),['library']).totalCost,9);
});

test('ties use lexicographic stop IDs and remain invariant under manifest/matrix permutations', () => {
  const input=matrix(3,Array.from({length:4},(_,i)=>Array.from({length:4},(_,j)=>i===j?0:2)));
  const changed=reorder(input,['s2','s0','depot','s1']);
  assert.deepEqual(validateInput(changed),validateInput(input));
  const a=optimizeRoute(input,['s2','s0','s1']), b=optimizeRoute(changed,['s1','s2','s0']);
  assert.deepEqual(a,b); assert.deepEqual(a.tour,['depot','s0','s1','s2','depot']);
  assert.deepEqual(input.travel.ids,['depot','s0','s1','s2']);
});

test('all Skip stays at depot; null directed legs can make a tour impossible', () => {
  const input=matrix(2,[[0,2,1],[null,0,1],[1,1,0]]);
  assert.deepEqual(optimizeRoute(input,[]),{status:'feasible',tour:['depot'],legs:[],totalCost:0,costUnit:'minutes',tieBreak:'lexicographic_stop_ids'});
  assert.equal(optimizeRoute(input,['s0']).status,'infeasible');
  assert.deepEqual(optimizeRoute(input,['s0','s1']).tour,['depot','s0','s1','depot']);
  // s1 offers a path back, but a skipped stop is never silently used as transit.
  assert.equal(optimizeRoute(input,['s0']).totalCost,null);
  for (const ids of [['s0','s0'],['missing'],['depot'],null]) assert.throws(()=>optimizeRoute(input,ids));
});

test('exact optimizer matches independent subset-DP oracle across small directed graphs and every required subset', () => {
  let seed=1847;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed;};
  for(let n=1;n<=5;n++) for(let trial=0;trial<12;trial++) {
    const input=matrix(n,Array.from({length:n+1},(_,i)=>Array.from({length:n+1},(_,j)=>i===j?0:(random()%5===0?null:1+random()%20))));
    for(let mask=0;mask<(1<<n);mask++) {
      const required=input.stops.filter((_,i)=>mask & (1<<i)).map(s=>s.id), result=optimizeRoute(input,required);
      assert.equal(result.totalCost,oracle(input,required),`n=${n}, trial=${trial}, mask=${mask}`);
      if(result.tour) {
        assert.equal(result.tour[0],input.depot.id); assert.equal(result.tour.at(-1),input.depot.id);
        assert.deepEqual(result.tour.length===1?[]:result.tour.slice(1,-1).sort(),required);
        assert.equal(result.legs.reduce((sum,leg)=>sum+leg.cost,0),result.totalCost);
      }
    }
  }
});

test('eight-stop bound and maximum costs stay exact safe integers', () => {
  const input=matrix(8,Array.from({length:9},(_,i)=>Array.from({length:9},(_,j)=>i===j?0:1000000)));
  const result=optimizeRoute(input,input.stops.map(s=>s.id));
  assert.equal(result.totalCost,9000000); assert.ok(Number.isSafeInteger(result.totalCost));
  assert.deepEqual(result.tour,['depot',...input.stops.map(s=>s.id),'depot']);
  const longest=structuredClone(input); longest.title='T'.repeat(60); longest.depot.label='D'.repeat(40);
  longest.stops[0].label='L'.repeat(40); longest.stops[0].details='X'.repeat(100);
  assert.ok(requestFor(longest,CONFIG,'s0',id(99)).prompt.length<=500);
});

test('malformed matrix, IDs, costs and bounds fail before any API read or write', async t => {
  for (const mutate of [
    x=>{x.stops=[];}, x=>{x.stops.push(...x.stops,...x.stops,...x.stops);},
    x=>{x.travel.costs.pop();}, x=>{x.travel.costs[0].pop();}, x=>{x.travel.ids[0]='unknown';},
    x=>{x.travel.ids[1]=x.travel.ids[0];}, x=>{x.travel.costs[0][0]=null;}, x=>{x.travel.costs[1][1]=1;},
    x=>{x.travel.costs[0][1]=0;}, x=>{x.travel.costs[0][1]=-1;}, x=>{x.travel.costs[0][1]=0.1;},
    x=>{x.travel.costs[0][1]=1000001;}, x=>{x.travel.costs[0][1]=Number.MAX_SAFE_INTEGER;},
    x=>{x.travel.costs[0][1]=NaN;}, x=>{x.travel.costs[0][1]='2';}, x=>{x.costUnit='';},
    x=>{x.stops[0].id=x.depot.id;}, x=>{x.stops[0].id='constructor';}, x=>{x.extra=true;},
  ]) { const s=await setup(t); mutate(s.options.input); await assert.rejects(s.run()); assert.equal(s.api.calls.length,0); }
});

test('required/skip choices produce a replayable route; every Skip yields zero travel', async t => {
  const s=await setup(t,structuredClone(example)), result=await decide(s,['required','skip','required']);
  assert.equal(result.status,'complete'); assert.deepEqual(result.requiredStopIds,['library','studio']); assert.deepEqual(result.skippedStopIds,['store']);
  assert.equal(result.route.totalCost,15); assert.ok(result.choices.every(c=>c.responderId===CONFIG.participant.id && c.askerId===ASKER));
  const calls=s.api.calls.length; assert.deepEqual((await localReport(s.directory,s.options.input)).route,result.route); assert.equal(s.api.calls.length,calls);
  const skipped=await setup(t,twoItems()), empty=await decide(skipped,['skip','skip']);
  assert.equal(empty.status,'complete'); assert.deepEqual(empty.route.tour,['depot']); assert.equal(empty.route.totalCost,0);
});

test('Unknown, cancellation, expiry and missing answers withhold the route', async t => {
  const s=await setup(t,twoItems()), result=await decide(s,['unknown','required']);
  assert.equal(result.status,'incomplete'); assert.equal(result.route,null); assert.deepEqual(result.unknownStopIds,['library']);
  for(const state of ['cancelled','expired']) {
    const item=await setup(t); await item.run(); if(state==='expired') item.clock.value='2026-01-01T09:16:00.000Z';
    item.api.terminal(id(1),state); const final=await item.run(); assert.equal(final.status,'incomplete'); assert.equal(final.route,null);
  }
  const missing=await setup(t); assert.equal((await missing.run()).route,null);
});

test('fully classified but unreachable tour is infeasible without speculative route output', async t => {
  const input=simple(); input.travel.costs[1][0]=null;
  const s=await setup(t,input), result=await decide(s,['required']);
  assert.equal(result.status,'infeasible'); assert.equal(result.route.tour,null); assert.equal(result.route.totalCost,null);
});

test('matrix, participant, room and credential changes refuse resuming before network; equivalent permutations resume', async t => {
  const s=await setup(t,structuredClone(example)); await s.run(); const calls=s.api.calls.length;
  const changed=structuredClone(s.options.input); changed.travel.costs[0][1]++;
  for(const extra of [{input:changed},{token:'other'},{room:'OTHER1234567'},{config:{participant:{id:OTHER,label:'Other'}}}]) await assert.rejects(s.run(extra));
  assert.equal(s.api.calls.length,calls);
  assert.equal((await s.run({input:reorder(s.options.input,['studio','library','depot','store'])})).status,'pending');
});

test('observation time cannot move backwards across repeated pending reads', async t => {
  const s=await setup(t); await s.run(); s.clock.value='2026-01-01T09:01:00.000Z'; await s.run();
  const previous=await readFile(join(s.directory,'state.json'),'utf8'); s.clock.value='2026-01-01T09:00:30.000Z';
  await assert.rejects(s.run(),/regressed/); assert.equal(await readFile(join(s.directory,'state.json'),'utf8'),previous);
});
