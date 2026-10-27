import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { acquireLock, readJson, atomicJson } from './storage.js';
import { validateInput, validateConfig, validateState, report, hash, ROOM, isId, iso, requestFor, observeQuestion, assertParticipantRoom } from './model.js';

const active = (state) => ['creating', 'pending'].includes(state.attempts.at(-1)?.status) ? state.attempts.at(-1) : null;

/** One stop choice creation or read per invocation, with no automatic POST retry. */
export async function step({ client, directory, input: rawInput, config: rawConfig, token, room, command = 'run', attachId,
  now = () => new Date().toISOString(), signal, write = atomicJson }) {
  const input = validateInput(rawInput), config = validateConfig(rawConfig);
  if (typeof token !== 'string' || !token || typeof room !== 'string' || !ROOM.test(room)) throw new Error('A complete connection is required.');
  if (!['run', 'recover', 'find'].includes(command) || attachId !== undefined && !isId(attachId)
    || command === 'recover' && !attachId) throw new Error('Invalid operation or Question UUID.');
  const release = await acquireLock(directory);
  try {
    signal?.throwIfAborted();
    let state = await readJson(join(directory, 'state.json'));
    if (state !== null) {
      validateState(state, input);
      if (state.credentialHash !== hash(token) || state.room !== room || hash(state.config) !== hash(config)) throw new Error('State belongs to another connection, room, or participant.');
    } else {
      if (command !== 'run') throw new Error('No existing route session to recover.');
      assertParticipantRoom(await client.rooms.list(), room, config.participant.id);
      signal?.throwIfAborted();
      state = { version: 1, inputHash: hash(input), config, room, credentialHash: hash(token), startedAt: iso(now()), attempts: [] };
      validateState(state, input);
      await write(directory, 'state.json', state);
    }
    const save = async (next) => { validateState(next, input); await write(directory, 'state.json', next); state = next; };
    const finish = (observedStatus = null) => ({ ...report(state, input), observedStatus });
    let attempt = active(state);
    if (command === 'find') {
      if (attempt?.status !== 'creating') throw new Error('No uncertain creation needs an ID search.');
      const questions = await client.questions.list({ state: 'all' });
      if (!Array.isArray(questions) || questions.length > 200) throw new Error('Question list exceeds the bounded recent window.');
      const candidates = [];
      for (const question of questions) {
        try { observeQuestion(question, attempt.request, question.id, room, iso(now())); candidates.push({ id: question.id, state: question.state }); }
        catch { /* No matching candidate does not prove the original request failed. */ }
      }
      return { ...finish(), candidates };
    }
    if (command === 'recover' && !attempt) throw new Error('No active or uncertain stop choice to recover.');
    if (attempt?.status === 'creating' && command !== 'recover') return finish();
    let question;
    if (attempt) {
      if (attempt.questionId && attachId && attachId !== attempt.questionId) throw new Error('This stop choice already tracks a different Question.');
      question = await client.questions.get(attempt.questionId ?? attachId);
    } else {
      const item = input.stops[state.attempts.length];
      if (!item) return finish();
      assertParticipantRoom(await client.rooms.list(), room, config.participant.id);
      signal?.throwIfAborted();
      const id = randomUUID();
      attempt = { id, itemId: item.id, createdAt: iso(now()), request: requestFor(input, config, item.id, id), questionId: null, status: 'creating', observation: null };
      const reserved = { ...state, attempts: [...state.attempts, attempt] };
      if (Buffer.byteLength(JSON.stringify(reserved, null, 2)) + 4096 > 1024 * 1024) throw new Error('Insufficient state capacity for another question.');
      await save(reserved);
      signal?.throwIfAborted();
      try { question = await client.questions.ask(room, attempt.request); }
      catch { return finish(); }
    }
    signal?.throwIfAborted();
    const expectedId = attempt.questionId ?? attachId ?? question?.id;
    const observed = observeQuestion(question, attempt.request, expectedId, room, iso(now()));
    if (attempt.observation && observed.observation.checkedAt < attempt.observation.checkedAt) throw new Error('Observation time regressed. Check the local clock.');
    if (attempt.observation && (observed.observation.createdAt !== attempt.observation.createdAt
      || observed.observation.expiresAt !== attempt.observation.expiresAt || observed.observation.askerId !== attempt.observation.askerId)) throw new Error('Question identity or lifetime changed after its first observation.');
    attempt = { ...attempt, questionId: expectedId, ...observed };
    await save({ ...state, attempts: state.attempts.map((item) => item.id === attempt.id ? attempt : item) });
    return finish(attempt.status);
  } finally { await release(); }
}

export async function localReport(directory, input, { save = false } = {}) {
  input = validateInput(input);
  const release = await acquireLock(directory);
  try {
    const state = await readJson(join(directory, 'state.json'));
    if (state === null) return { status: 'not_started' };
    const result = report(state, input);
    if (save) await atomicJson(directory, 'report.json', result);
    return result;
  } finally { await release(); }
}
