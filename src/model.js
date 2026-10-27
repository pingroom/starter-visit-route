import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const ROOM = /^[A-Z0-9]{12}$/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => record(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
const line = (value, max) => typeof value === 'string' && value.length <= max && /^[\x20-\x7e]+$/.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}

export function validateInput(input) {
  if (!keys(input, ['routeId', 'title', 'costUnit', 'depot', 'stops', 'travel']) || !word(input.routeId)
    || !line(input.title, 60) || !line(input.costUnit, 20) || !keys(input.depot, ['id', 'label'])
    || !word(input.depot.id) || input.depot.id.length > 24 || !line(input.depot.label, 40)
    || !Array.isArray(input.stops) || input.stops.length < 1 || input.stops.length > 8) throw new Error('Provide a route ID, title, cost unit, depot, and one to eight stops.');
  const ids = new Set([input.depot.id]);
  for (const stop of input.stops) {
    if (!keys(stop, ['id', 'label', 'details']) || !word(stop.id) || stop.id.length > 24 || ids.has(stop.id)
      || !line(stop.label, 40) || !line(stop.details, 100)) throw new Error('Stops need unique bounded IDs, labels, and details.');
    ids.add(stop.id);
  }
  if ([...ids].some(id => ['constructor', 'prototype', '__proto__'].includes(id))) throw new Error('Reserved location ID.');
  const travel = input.travel, size = ids.size;
  if (!keys(travel, ['ids', 'costs']) || !Array.isArray(travel.ids) || travel.ids.length !== size
    || travel.ids.some(id => !ids.has(id)) || new Set(travel.ids).size !== size
    || !Array.isArray(travel.costs) || travel.costs.length !== size) throw new Error('The travel matrix must name the depot and every stop exactly once.');
  for (const [from, row] of travel.costs.entries()) {
    if (!Array.isArray(row) || row.length !== size || row.some((cost, to) => from === to ? cost !== 0
      : cost !== null && (!Number.isSafeInteger(cost) || cost < 1 || cost > 1000000))) throw new Error('Use zero diagonal costs and positive integer costs up to 1000000, or null for unreachable directed legs.');
  }
  const stops = structuredClone(input.stops).sort((a, b) => compare(a.id, b.id));
  const orderedIds = [input.depot.id, ...stops.map(stop => stop.id)];
  const indices = orderedIds.map(id => travel.ids.indexOf(id));
  return { routeId: input.routeId, title: input.title, costUnit: input.costUnit, depot: structuredClone(input.depot), stops,
    travel: { ids: orderedIds, costs: indices.map(i => indices.map(j => travel.costs[i][j])) } };
}

export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id)
    || !line(config.participant.label, 60)) throw new Error('Config requires an exact operator UUID and label.');
  return structuredClone(config);
}

export function requestFor(rawInput, config, itemId, attemptId) {
  const input = validateInput(rawInput), stop = input.stops.find(stop => stop.id === itemId);
  if (!stop || !isId(attemptId)) throw new Error('Invalid stop or attempt.');
  const key = `route-${attemptId}`;
  const prompt = `${input.title}\nStop ${stop.id}: ${stop.label}\n${stop.details}\nShould this fixed visit route include this stop? Required includes it once; Skip omits it. Choose Unknown if unsure. The route starts and ends at ${input.depot.label}.`;
  if (prompt.length > 500) throw new Error('Stop prompt exceeds 500 characters.');
  return { prompt, context: `Route ${hash(input).slice(0, 20)}`,
    options: [['required', 'Required'], ['skip', 'Skip'], ['unknown', 'Unknown']].map(([value, label]) => ({ value, label, style: 'default' })),
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), item_id: itemId, attempt_id: attemptId }, idempotencyKey: key };
}

/** Exhaust all selected-stop permutations; positive costs allow safe partial-cost pruning. */
export function optimizeRoute(rawInput, requiredIds) {
  const input = validateInput(rawInput);
  if (!Array.isArray(requiredIds) || requiredIds.length > input.stops.length || new Set(requiredIds).size !== requiredIds.length
    || requiredIds.some(id => !input.stops.some(stop => stop.id === id))) throw new Error('Required stops must be unique IDs from the manifest.');
  const required = [...requiredIds].sort(compare), positions = new Map(input.travel.ids.map((id, index) => [id, index]));
  const cost = (from, to) => input.travel.costs[positions.get(from)][positions.get(to)];
  const depot = input.depot.id;
  if (!required.length) return { status: 'feasible', tour: [depot], legs: [], totalCost: 0, costUnit: input.costUnit, tieBreak: 'lexicographic_stop_ids' };
  let bestCost = Infinity, bestTour = null;
  function visit(path, remaining, subtotal) {
    if (subtotal > bestCost) return;
    if (!remaining.length) {
      const home = cost(path.at(-1), depot);
      if (home !== null && subtotal + home < bestCost) { bestCost = subtotal + home; bestTour = [...path, depot]; }
      return;
    }
    for (const next of remaining) {
      const leg = cost(path.at(-1), next);
      if (leg !== null) visit([...path, next], remaining.filter(id => id !== next), subtotal + leg);
    }
  }
  visit([depot], required, 0);
  return { status: bestTour === null ? 'infeasible' : 'feasible', tour: bestTour,
    legs: bestTour === null ? [] : bestTour.slice(1).map((to, i) => ({ from: bestTour[i], to, cost: cost(bestTour[i], to) })),
    totalCost: bestTour === null ? null : bestCost, costUnit: input.costUnit, tieBreak: 'lexicographic_stop_ids' };
}
export function validateState(state, rawInput) {
  const input = validateInput(rawInput);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > input.stops.length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed route manifest. Restore the original input and configuration.');
  validateConfig(state.config);
  const items = input.stops, ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'itemId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.itemId !== items[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.itemId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved stop request or order.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates its saved creation intent.');
      previous = attempt.observation.checkedAt;
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last stop may have an active Question.');
  }
  return state;
}

export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const choices = input.stops.map(stop => {
    const attempt = state.attempts.find(attempt => attempt.itemId === stop.id), answer = attempt?.observation?.answer;
    return { itemId: stop.id, label: stop.label, status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      choice: answer?.value ?? null, questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
      responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null,
      askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const active = choices.find(item => ['create_unknown', 'pending'].includes(item.status));
  const complete = choices.every(item => ['required', 'skip'].includes(item.choice));
  const requiredStopIds = choices.filter(item => item.choice === 'required').map(item => item.itemId);
  const route = complete ? optimizeRoute(input, requiredStopIds) : null;
  const status = active?.status ?? (choices.some(item => item.status === 'unasked') ? 'ready'
    : !complete ? 'incomplete' : route.status === 'infeasible' ? 'infeasible' : 'complete');
  return { routeId: input.routeId, title: input.title, inputHash: hash(input), status, participant: state.config.participant,
    depot: input.depot, choices, requiredStopIds, skippedStopIds: choices.filter(item => item.choice === 'skip').map(item => item.itemId),
    unknownStopIds: choices.filter(item => item.choice === 'unknown').map(item => item.itemId),
    unansweredStops: choices.filter(item => item.status !== 'answered').map(({ itemId, status }) => ({ itemId, status })), route,
    assumptions: ['The fixed directed matrix describes each allowed leg in one declared unit.', 'Every required stop is visited once, starting and ending at the depot.', 'No time windows, service durations, capacity, traffic or dispatch are modeled.'] };
}
function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved stop-choice evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered stop choices must not contain choice evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || q.options.some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || option?.primary !== false || option?.destructive !== false)) throw new Error('Question does not match the saved stop, room, or operator.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
