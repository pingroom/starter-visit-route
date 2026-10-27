import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './storage.js';
import { step } from './engine.js';
import { CONFIG, ROOM_CODE, mockApi } from './mock.js';

const example = await readJson(new URL('../examples/route.json', import.meta.url), 65536);
for (const scenario of ['shortest tour', 'unreachable return', 'unknown stop']) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-route-demo-'));
  try {
    const input = structuredClone(example);
    if (scenario === 'unreachable return') for (let row = 1; row < input.travel.costs.length; row++) input.travel.costs[row][0] = null;
    const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
    let result;
    for (let index = 0; index < input.stops.length; index++) {
      const pending = await step(options);
      api.answer(pending.choices.find(item => item.status === 'pending').questionId, scenario === 'unknown stop' && index === 0 ? 'unknown' : 'required');
      result = await step(options);
    }
    assert.equal(api.calls.filter(call => call.method === 'POST').length, 3);
    if (scenario === 'shortest tour') { assert.equal(result.status, 'complete'); assert.equal(result.route.totalCost, 12); }
    if (scenario === 'unreachable return') { assert.equal(result.status, 'infeasible'); assert.equal(result.route.tour, null); }
    if (scenario === 'unknown stop') { assert.equal(result.status, 'incomplete'); assert.equal(result.route, null); }
    console.log(JSON.stringify({ scenario, status: result.status, requiredStopIds: result.requiredStopIds, unknownStopIds: result.unknownStopIds, route: result.route }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
