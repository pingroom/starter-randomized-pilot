import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const ROOM = /^[A-Z0-9]{12}(?![\s\S])/;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function validateInput(input) {
  if (!keys(input, ['pilotId', 'title', 'successCriterion', 'arms', 'units']) || !word(input.pilotId)
    || !line(input.title, 32) || !line(input.successCriterion, 70) || !Array.isArray(input.arms) || input.arms.length !== 2
    || !Array.isArray(input.units) || input.units.length < 2 || input.units.length > 8 || input.units.length % 2 !== 0) throw new Error('Provide a pilot ID, title, shared success criterion, arms A/B, and an even number of units from two to eight.');
  const arms = structuredClone(input.arms).sort((a, b) => compare(a?.id, b?.id));
  for (const [index, arm] of arms.entries()) {
    if (!keys(arm, ['id', 'label', 'procedure']) || arm.id !== ['A', 'B'][index]
      || !line(arm.label, 16) || !line(arm.procedure, 70)) throw new Error('Define exactly arms A and B, each with a label and fixed procedure.');
  }
  if (arms[0].procedure === arms[1].procedure) throw new Error('Arm procedures must differ.');
  const ids = new Set();
  for (const unit of input.units) {
    if (!keys(unit, ['id', 'description']) || !word(unit.id) || unit.id.length > 24 || ids.has(unit.id)
      || ['constructor', 'prototype', '__proto__'].includes(unit.id) || !line(unit.description, 70)) throw new Error('Units require unique IDs and fixed descriptions up to 70 UTF-16 units.');
    ids.add(unit.id);
  }
  return { pilotId: input.pilotId, title: input.title, successCriterion: input.successCriterion, arms,
    units: structuredClone(input.units).sort((a, b) => compare(a.id, b.id)) };
}

export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id)
    || !line(config.participant.label, 60)) throw new Error('Config requires an exact operator UUID and label.');
  return structuredClone(config);
}

export function balancedSubsets(rawInput) {
  const input = validateInput(rawInput), size = input.units.length / 2, subsets = [];
  function choose(start, selected) {
    if (selected.length === size) { subsets.push(selected); return; }
    for (let index = start; index <= input.units.length - (size - selected.length); index++) choose(index + 1, [...selected, input.units[index].id]);
  }
  choose(0, []); return subsets;
}

export function allocationFor(rawInput, index) {
  const input = validateInput(rawInput), subsets = balancedSubsets(input);
  if (!Number.isSafeInteger(index) || index < 0 || index >= subsets.length) throw new Error('Invalid balanced allocation index.');
  const armA = new Set(subsets[index]);
  return { version: 1, method: 'uniform_balanced_index_v1', index, totalAssignments: subsets.length,
    assignments: input.units.map(unit => ({ unitId: unit.id, armId: armA.has(unit.id) ? 'A' : 'B' })) };
}

export function validateAllocation(input, allocation) {
  if (!keys(allocation, ['version', 'method', 'index', 'totalAssignments', 'assignments'])
    || hash(allocation) !== hash(allocationFor(input, allocation.index))) throw new Error('Saved allocation does not match its balanced index and fixed units.');
  return allocation;
}

export function validateJournal(journal, rawInput) {
  const input = validateInput(rawInput);
  if (!keys(journal, ['version', 'phase', 'inputHash', 'config', 'room', 'credentialHash', 'createdAt', 'allocation'])
    || journal.version !== 1 || !['prepared', 'active'].includes(journal.phase) || journal.inputHash !== hash(input)
    || typeof journal.room !== 'string' || !ROOM.test(journal.room) || typeof journal.credentialHash !== 'string'
    || !/^[0-9a-f]{64}(?![\s\S])/.test(journal.credentialHash) || iso(journal.createdAt) !== journal.createdAt) throw new Error('Invalid allocation journal or changed pilot manifest. Preserve the original files.');
  validateConfig(journal.config); validateAllocation(input, journal.allocation); return journal;
}

export function requestFor(rawInput, config, itemId, attemptId, allocation) {
  const input = validateInput(rawInput), unit = input.units.find(item => item.id === itemId);
  validateConfig(config); validateAllocation(input, allocation);
  if (!unit || !isId(attemptId)) throw new Error('Invalid unit or attempt.');
  const assigned = allocation.assignments.find(item => item.unitId === unit.id), arm = input.arms.find(arm => arm.id === assigned.armId);
  const key = `pilot-${attemptId}`;
  const prompt = `${input.title}\nUnit ${unit.id}: ${unit.description}\nArm ${arm.id}: ${arm.label}\nProcedure: ${arm.procedure}\nSuccess: ${input.successCriterion}\nAfter this procedure: Success, Failure, or Unknown if unmeasured.`;
  if (prompt.length > 500) throw new Error('Outcome prompt exceeds 500 characters.');
  return { prompt, context: `To ${config.participant.id}`,
    options: [['success', 'Success'], ['failure', 'Failure'], ['unknown', 'Unknown']].map(([value, label]) => ({ value, label, style: 'default' })),
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), allocation_hash: hash(allocation), item_id: itemId, attempt_id: attemptId }, idempotencyKey: key };
}

export function analyzePilot(rawInput, allocation, outcomes) {
  const input = validateInput(rawInput); validateAllocation(input, allocation);
  if (!keys(outcomes, input.units.map(unit => unit.id)) || Object.values(outcomes).some(value => !['success', 'failure'].includes(value))) throw new Error('Every randomized unit requires Success or Failure; no Unknown or complete-case analysis.');
  const successes = new Set(input.units.filter(unit => outcomes[unit.id] === 'success').map(unit => unit.id)), size = input.units.length / 2;
  const arms = input.arms.map(arm => {
    const unitIds = allocation.assignments.filter(item => item.armId === arm.id).map(item => item.unitId);
    const count = unitIds.filter(id => successes.has(id)).length;
    return { armId: arm.id, label: arm.label, unitIds, total: size, successes: count, failures: size - count,
      rate: { numerator: count, denominator: size, value: count / size } };
  });
  const signed = arms[0].successes - arms[1].successes, observed = Math.abs(signed), distribution = new Map();
  const subsets = balancedSubsets(input); let extreme = 0;
  for (const subset of subsets) {
    const successesA = subset.filter(id => successes.has(id)).length;
    const statistic = Math.abs(successesA - (successes.size - successesA));
    if (statistic >= observed) extreme++;
    distribution.set(statistic, (distribution.get(statistic) ?? 0) + 1);
  }
  return { arms, difference: { orientation: 'A_minus_B', numerator: signed, denominator: size, value: signed / size },
    randomization: { method: 'exact_balanced_reassignment', nullHypothesis: 'no_unit_outcome_changes_under_A_or_B',
      statistic: 'absolute_success_count_difference', observedStatistic: observed, tailIncludesTies: true,
      pValue: { numerator: extreme, denominator: subsets.length, value: extreme / subsets.length },
      distribution: [...distribution].sort(([a], [b]) => a - b).map(([statistic, assignments]) => ({ statistic, assignments })) } };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'allocation', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}(?![\s\S])/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > input.units.length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed pilot manifest. Restore the original input and configuration.');
  validateConfig(state.config); validateAllocation(input, state.allocation);
  const items = input.units, ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'itemId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.itemId !== items[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.itemId, attempt.id, state.allocation))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved unit outcome or order.');
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
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last unit may have an active Question.');
  }
  return state;
}


export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const answers = input.units.map(unit => {
    const attempt = state.attempts.find(attempt => attempt.itemId === unit.id), answer = attempt?.observation?.answer;
    return { unitId: unit.id, description: unit.description, armId: state.allocation.assignments.find(item => item.unitId === unit.id).armId,
      status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      choice: answer?.value ?? null, choiceLabel: answer?.label ?? null,
      questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
      responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null,
      askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const active = answers.find(item => ['create_unknown', 'pending'].includes(item.status));
  const complete = answers.every(item => item.status === 'answered' && ['success', 'failure'].includes(item.choice));
  const analysis = complete ? analyzePilot(input, state.allocation, Object.fromEntries(answers.map(item => [item.unitId, item.choice]))) : null;
  const status = active?.status ?? (answers.some(item => item.status === 'unasked') ? 'ready' : complete ? 'complete' : 'incomplete');
  return { pilotId: input.pilotId, title: input.title, successCriterion: input.successCriterion, inputHash: hash(input), status,
    participant: state.config.participant, arms: input.arms, units: input.units, allocation: state.allocation, allocatedAt: state.startedAt,
    allocationHash: hash(state.allocation), answers, analysis,
    unknownUnitIds: answers.filter(item => item.choice === 'unknown').map(item => item.unitId),
    unansweredUnits: answers.filter(item => item.status !== 'answered').map(({ unitId, status }) => ({ unitId, status })),
    proceduresExecuted: false, winnerSelected: false,
    assumptions: ['Uniform balanced assignment precedes all outcomes; use the saved assignment and do not rerandomize or drop units.',
      'The sharp no-effect assumption fixes each unit\'s binary outcome under A or B. No interference between units is modeled.',
      'The exact tail includes ties and the actual allocation; no Monte Carlo correction or automatic decision is applied.',
      'Results do not establish causality, generalizability, or power. Allocation integrity assumes untouched local state.'] };
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
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved unit outcome evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered unit outcomes must not contain unit outcome evidence.');
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
      || option?.primary !== false || option?.destructive !== false)) throw new Error('Question does not match the saved unit, room, or operator.');
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
