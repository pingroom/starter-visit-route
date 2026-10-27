import assert from 'node:assert/strict';
import { makeClient, API } from './client.js';

export const ROOM_CODE = 'DEMO12345678';
export const PARTICIPANT = '11111111-1111-4111-8111-111111111111';
export const OTHER = '22222222-2222-4222-8222-222222222222';
export const ASKER = '33333333-3333-4333-8333-333333333333';
export const CONFIG = { participant: { id: PARTICIPANT, label: 'Operator' } };
export const id = (number) => `01990000-0000-7000-8000-${String(number).padStart(12, '0')}`;

/** In-memory API behind the real pinned SDK. It never calls a network. */
export function mockApi(now) {
  const questions = new Map(), calls = [];
  const controls = { loseNext: false, malformedNext: false, readError: false };
  const rooms = [{ invite_code: ROOM_CODE, type: 'standard', is_public: false, members: [{ user_id: PARTICIPANT }, { user_id: OTHER }] }];
  const client = makeClient({ token: 'offline-fixture-token', fetchImpl: async (rawUrl, init) => {
    const url = new URL(rawUrl);
    assert.equal(url.origin, API); assert.equal(init.redirect, 'manual');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer offline-fixture-token');
    const body = init.body === undefined ? null : JSON.parse(init.body);
    calls.push({ method: init.method, path: url.pathname, body });
    if (init.method === 'GET' && url.pathname === '/api/agent/rooms') return Response.json(rooms);
    if (init.method === 'POST' && url.pathname === `/api/agent/rooms/${ROOM_CODE}/questions`) {
      assert.equal(new Headers(init.headers).get('idempotency-key'), body.correlation_id);
      assert.equal(body.responder_scope, 'direct'); assert.equal(body.target_user_id, PARTICIPANT);
      assert.equal(body.ttl, 900); assert.equal(body.options.length, 3);
      const questionId = id(questions.size + 1);
      const question = { id: questionId, kind: 'question', is_handoff: false, prompt: body.prompt, context: body.context,
        options: body.options.map(({ value, label }) => ({ value, label, primary: false, destructive: false })),
        text_input: null, responder_scope: 'direct', target_user_id: body.target_user_id, resolution_policy: 'first',
        state: 'pending', results: null, answer: null, expires_at: new Date(Date.parse(now()) + body.ttl * 1000).toISOString(),
        resolved_at: null, correlation_id: body.correlation_id, reply_to: null, data: body.data, created_at: now(),
        room_code: ROOM_CODE, room: { code: ROOM_CODE }, asker: { type: 'agent', id: ASKER } };
      questions.set(questionId, question);
      if (controls.loseNext) { controls.loseNext = false; throw new Error('Simulated lost response after creation.'); }
      if (controls.malformedNext) { controls.malformedNext = false; return Response.json({ id: questionId }); }
      return Response.json(question, { status: 201 });
    }
    if (init.method === 'GET' && url.pathname === '/api/agent/questions') {
      assert.equal(url.searchParams.get('state'), 'all');
      return Response.json({ questions: [...questions.values()] });
    }
    const questionId = url.pathname.slice('/api/agent/questions/'.length);
    if (init.method === 'GET' && questions.has(questionId)) {
      if (controls.readError) return Response.json({ code: 'unavailable' }, { status: 503 });
      return Response.json(questions.get(questionId));
    }
    throw new Error('Unexpected mock API request.');
  } });
  return { client, questions, calls, controls, rooms,
    answer(questionId, value) {
      const q = questions.get(questionId), option = q.options.find((item) => item.value === value);
      q.state = 'answered'; q.resolved_at = now();
      q.answer = { value, label: option?.label, text: null, responder: { id: PARTICIPANT }, answered_at: now() };
    },
    terminal(questionId, state) {
      const q = questions.get(questionId); q.state = state; q.answer = null;
      q.resolved_at = state === 'expired' ? q.expires_at : now();
    },
  };
}
