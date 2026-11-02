import { randomInt, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { acquireLock, readJson, atomicJson } from './storage.js';
import { validateInput, validateConfig, validateState, validateJournal, allocationFor, balancedSubsets, report,
  hash, ROOM, TOKEN, isId, iso, requestFor, observeQuestion, assertParticipantRoom } from './model.js';

const active = state => ['creating', 'pending'].includes(state.attempts.at(-1)?.status) ? state.attempts.at(-1) : null;

async function readSession(directory, input) {
  const journal = await readJson(join(directory, 'allocation.json'));
  const state = await readJson(join(directory, 'state.json'));
  if (journal === null) {
    if (state !== null) throw new Error('Allocation journal is missing. Restore the original journal; do not redraw.');
    return { journal, state };
  }
  validateJournal(journal, input);
  if (state === null) {
    if (journal.phase === 'active') throw new Error('Active pilot state is missing. Restore the original state; do not reset or redraw.');
    return { journal, state };
  }
  validateState(state, input);
  if (state.startedAt !== journal.createdAt || state.room !== journal.room || state.credentialHash !== journal.credentialHash
    || hash(state.config) !== hash(journal.config) || hash(state.allocation) !== hash(journal.allocation)
    || journal.phase === 'prepared' && state.attempts.length !== 0) throw new Error('Pilot state and allocation journal disagree. Restore matching originals.');
  return { journal, state };
}

/** Persist allocation before outcomes; one Question creation or read per invocation. */
export async function step({ client, directory, input: rawInput, config: rawConfig, token, room, command = 'run', attachId,
  now = () => new Date().toISOString(), signal, write = atomicJson, drawAllocation = randomInt }) {
  const input = validateInput(rawInput), config = validateConfig(rawConfig);
  if (typeof token !== 'string' || !TOKEN.test(token) || typeof room !== 'string' || !ROOM.test(room)) throw new Error('A complete connection is required.');
  if (!['run', 'allocate', 'recover', 'find'].includes(command) || attachId !== undefined && !isId(attachId)
    || command === 'recover' && !attachId) throw new Error('Invalid operation or Question UUID.');
  const release = await acquireLock(directory);
  try {
    signal?.throwIfAborted();
    let { journal, state } = await readSession(directory, input);
    if (journal !== null && (journal.credentialHash !== hash(token) || journal.room !== room || hash(journal.config) !== hash(config))) throw new Error('Allocation belongs to another connection, room, or operator.');
    if (journal === null) {
      if (!['run', 'allocate'].includes(command)) throw new Error('No existing pilot session to recover.');
      assertParticipantRoom(await client.rooms.list(), room, config.participant.id);
      signal?.throwIfAborted();
      const allocation = allocationFor(input, drawAllocation(balancedSubsets(input).length));
      journal = { version: 1, phase: 'prepared', inputHash: hash(input), config, room, credentialHash: hash(token), createdAt: iso(now()), allocation };
      validateJournal(journal, input);
      await write(directory, 'allocation.json', journal);
    }
    if (state === null) {
      if (!['run', 'allocate'].includes(command)) throw new Error('Allocation is prepared but no outcome session exists. Run allocate to resume initialization.');
      state = { version: 1, inputHash: hash(input), config, room, credentialHash: hash(token), startedAt: journal.createdAt, allocation: journal.allocation, attempts: [] };
      validateState(state, input); await write(directory, 'state.json', state);
    }
    if (journal.phase === 'prepared') {
      journal = { ...journal, phase: 'active' };
      await write(directory, 'allocation.json', journal);
    }
    const save = async next => { validateState(next, input); await write(directory, 'state.json', next); state = next; };
    const finish = (observedStatus = null) => ({ ...report(state, input), observedStatus });
    if (command === 'allocate') return finish();
    let attempt = active(state);
    if (command === 'find') {
      if (attempt?.status !== 'creating') throw new Error('No uncertain creation needs an ID search.');
      const questions = await client.questions.list({ state: 'all' });
      if (!Array.isArray(questions) || questions.length > 200) throw new Error('Question list exceeds the bounded recent window.');
      const candidates = [];
      for (const question of questions) {
        try { observeQuestion(question, attempt.request, question.id, room, iso(now())); candidates.push({ id: question.id, state: question.state }); }
        catch { /* An absent candidate does not prove the original POST failed. */ }
      }
      return { ...finish(), candidates };
    }
    if (command === 'recover' && !attempt) throw new Error('No active or uncertain unit outcome to recover.');
    if (attempt?.status === 'creating' && command !== 'recover') return finish();
    let question;
    if (attempt) {
      if (attempt.questionId && attachId && attachId !== attempt.questionId) throw new Error('This unit already tracks a different Question.');
      question = await client.questions.get(attempt.questionId ?? attachId);
    } else {
      const unit = input.units[state.attempts.length];
      if (!unit) return finish();
      assertParticipantRoom(await client.rooms.list(), room, config.participant.id);
      signal?.throwIfAborted();
      const id = randomUUID();
      attempt = { id, itemId: unit.id, createdAt: iso(now()), request: requestFor(input, config, unit.id, id, state.allocation), questionId: null, status: 'creating', observation: null };
      const reserved = { ...state, attempts: [...state.attempts, attempt] };
      if (Buffer.byteLength(JSON.stringify(reserved, null, 2)) + 4096 > 1024 * 1024) throw new Error('Insufficient state capacity for another Question.');
      await save(reserved); signal?.throwIfAborted();
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
    await save({ ...state, attempts: state.attempts.map(item => item.id === attempt.id ? attempt : item) });
    return finish(attempt.status);
  } finally { await release(); }
}

export async function localReport(directory, input, { save = false } = {}) {
  input = validateInput(input);
  const release = await acquireLock(directory);
  try {
    const { journal, state } = await readSession(directory, input);
    if (journal === null) return { status: 'not_started' };
    if (state === null) return { status: 'allocation_prepared', allocation: journal.allocation, inputHash: journal.inputHash, analysis: null };
    const result = report(state, input);
    if (save) await atomicJson(directory, 'report.json', result);
    return result;
  } finally { await release(); }
}

export async function exportPilot(directory, input) {
  input = validateInput(input);
  const release = await acquireLock(directory);
  try {
    const { state } = await readSession(directory, input);
    if (state === null) throw new Error('No complete pilot session exists.');
    const result = report(state, input);
    if (result.status !== 'complete' || result.analysis === null) throw new Error('Every randomized unit requires Success or Failure before export.');
    await atomicJson(directory, 'pilot-analysis.json', { schemaVersion: 1, ...result });
    return { status: 'complete', path: join(directory, 'pilot-analysis.json'), inputHash: result.inputHash,
      allocationHash: result.allocationHash, pValue: result.analysis.randomization.pValue };
  } finally { await release(); }
}
