import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport, exportPilot } from '../src/engine.js';
import { readJson, readText, atomicJson, atomicText, acquireLock } from '../src/storage.js';
import { validateInput, validateState, analyzePilot, allocationFor, balancedSubsets, validateAllocation, validateJournal, ROOM, isId, requestFor as rawRequestFor, validateConfig, hash, iso } from '../src/model.js';
import { loadConnection, loadEnvironment, validateConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/pilot.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = simple;
const requestFor = (input, config, itemId, attemptId, allocation = allocationFor(input, 0)) => rawRequestFor(input, config, itemId, attemptId, allocation);
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-randomized-pilot-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const draws = { count: 0 };
  const options = { drawAllocation: () => { draws.count++; return 0; }, client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, draws, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.answers.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later unit outcomes; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'success'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
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

test('wrong, missing, typed or unsupported answers never resolve a unit outcome', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = 'success'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'success'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.analysis, null);
    await s.run(); assert.equal(sends(s.api), 2);
  }
});

test('original asker, lifetime and intent remain bound across reads and across unit outcomes', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), 'success'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).status, 'ready'); assert.equal((await localReport(s.directory, s.options.input)).analysis, null);
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
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'success');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'success'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'success'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing expert before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t);
  await assert.rejects(s.run({ write: async (...args) => { if (args[1] === 'state.json' && args[2].attempts[0]?.status === 'creating') throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'success');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t);
  await assert.rejects(s.run({ write: async (...args) => { if (args[1] === 'state.json' && args[2].attempts[0]?.status === 'pending') throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'success'); await s.run(); const original = await s.saved();
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
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).analysis, null); assert.equal(s.api.calls.length, before);
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
  const controller = new AbortController();
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (args[1] === 'state.json' && args[2].attempts[0]?.status === 'creating') controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});


test('observation time cannot regress across reads or precede a durable intent on disk',async t=>{
  const s=await setup(t);await s.run();s.clock.value='2026-01-01T09:01:00.000Z';await s.run();
  const before=await readFile(join(s.directory,'state.json'),'utf8');s.clock.value='2026-01-01T09:00:30.000Z';
  await assert.rejects(s.run(),/regressed/);assert.equal(await readFile(join(s.directory,'state.json'),'utf8'),before);
  const saved=await s.saved();saved.attempts[0].observation.checkedAt='2026-01-01T08:59:59.000Z';
  assert.throws(()=>validateState(saved,s.options.input),/predates/);
});





function manifest(count = 8) {
  return { pilotId: 'pilot-test', title: 'Harmless task pilot', successCriterion: 'The recorded task code matches the fixed answer key.',
    arms: [{id:'A',label:'Read in order',procedure:'Read task labels in order, then record the code.'},
      {id:'B',label:'Group labels',procedure:'Group task labels by prefix, then record the code.'}],
    units: Array.from({length:count},(_,i)=>({id:`unit-${i}`,description:`Fixed practice card ${i} and its answer key.`})) };
}
const outcomesFor = (input, value = 'success') => Object.fromEntries(validateInput(input).units.map(unit=>[unit.id,value]));
function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i++) result = result * (n - i + 1) / i;
  return result;
}

// Independent hypergeometric oracle counts success/failure selections without enumerating assignments.
function reference(input, allocation, outcomes) {
  const n = input.units.length, m = n / 2, totalSuccesses = Object.values(outcomes).filter(value => value === 'success').length;
  const observedA = allocation.assignments.filter(item => item.armId === 'A' && outcomes[item.unitId] === 'success').length;
  const signed = 2 * observedA - totalSuccesses, observed = Math.abs(signed);
  let numerator = 0;
  for (let successesA = 0; successesA <= m; successesA++) {
    if (Math.abs(2 * successesA - totalSuccesses) >= observed) numerator += choose(totalSuccesses, successesA) * choose(n - totalSuccesses, m - successesA);
  }
  return { numerator, denominator: choose(n,m), signed, observed, observedA, totalSuccesses };
}

test('all bounded allocations and binary outcome vectors match an independent hypergeometric oracle', () => {
  let cases = 0;
  for (const n of [2,4,6,8]) {
    const input = manifest(n), assignments = balancedSubsets(input);
    assert.equal(assignments.length, choose(n,n/2));
    for (let index = 0; index < assignments.length; index++) for (let mask = 0; mask < 2 ** n; mask++) {
      const allocation = allocationFor(input,index), outcomes = Object.fromEntries(input.units.map((unit,i)=>[unit.id,mask & (1<<i)?'success':'failure']));
      const actual = analyzePilot(input,allocation,outcomes), expected = reference(input,allocation,outcomes), tail = actual.randomization;
      assert.deepEqual(tail.pValue,{numerator:expected.numerator,denominator:expected.denominator,value:expected.numerator/expected.denominator});
      assert.equal(tail.observedStatistic,expected.observed); assert.equal(actual.difference.numerator,expected.signed);
      assert.equal(actual.difference.denominator,n/2); assert.equal(actual.difference.value,expected.signed/(n/2));
      assert.equal(actual.arms[0].successes,expected.observedA); assert.equal(actual.arms[1].successes,expected.totalSuccesses-expected.observedA);
      assert.equal(tail.distribution.reduce((sum,row)=>sum+row.assignments,0),expected.denominator);
      assert.equal(tail.distribution.filter(row=>row.statistic>=tail.observedStatistic).reduce((sum,row)=>sum+row.assignments,0),expected.numerator);
      assert.ok(tail.pValue.numerator>=1); assert.equal(tail.tailIncludesTies,true); cases++;
    }
  }
  assert.equal(cases,19304);
});

test('all-zero/all-one outcomes and every N=2 result have p=1; extreme eight-unit split has exact 2/70', () => {
  for (const n of [2,4,6,8]) {
    const input=manifest(n), allocation=allocationFor(input,0);
    for (const value of ['success','failure']) {
      const result=analyzePilot(input,allocation,outcomesFor(input,value)); assert.equal(result.randomization.pValue.value,1); assert.equal(result.difference.value,0);
    }
  }
  const small=manifest(2);
  for(const a of ['success','failure'])for(const b of ['success','failure'])assert.equal(analyzePilot(small,allocationFor(small,0),{'unit-0':a,'unit-1':b}).randomization.pValue.value,1);
  const input=manifest(), allocation=allocationFor(input,0), outcomes=Object.fromEntries(allocation.assignments.map(item=>[item.unitId,item.armId==='A'?'success':'failure']));
  const positive=analyzePilot(input,allocation,outcomes);assert.deepEqual(positive.randomization.pValue,{numerator:2,denominator:70,value:2/70});assert.equal(positive.difference.value,1);
  const opposite=allocationFor(input,69), negative=analyzePilot(input,opposite,outcomes);assert.equal(negative.difference.value,-1);assert.deepEqual(negative.randomization.pValue,positive.randomization.pValue);
});

test('balanced allocations are unique, complete and stable under unit and arm permutations', () => {
  const input=manifest(), subsets=balancedSubsets(input);assert.equal(subsets.length,70);assert.equal(new Set(subsets.map(JSON.stringify)).size,70);
  for(let i=0;i<70;i++){const allocation=allocationFor(input,i);assert.equal(allocation.assignments.filter(x=>x.armId==='A').length,4);assert.equal(allocation.assignments.length,8);validateAllocation(input,allocation);}
  const reordered=structuredClone(input);reordered.units.reverse();reordered.arms.reverse();
  assert.deepEqual(validateInput(reordered),validateInput(input));assert.deepEqual(balancedSubsets(reordered),subsets);
  assert.deepEqual(requestFor(reordered,CONFIG,'unit-0',id(99)),requestFor(input,CONFIG,'unit-0',id(99)));
});

test('maximum prompt includes assigned procedure, criterion and full unit description', () => {
  const input=manifest(2);input.title='😀'.repeat(16);input.successCriterion='😀'.repeat(35);
  input.units[0]={id:'u'.repeat(24),description:'😀'.repeat(35)};
  input.arms[0]={id:'A',label:'😀'.repeat(8),procedure:'😀'.repeat(35)};
  const allocation=allocationFor(input,1),request=requestFor(input,CONFIG,input.units[0].id,id(99),allocation);
  assert.ok(request.prompt.length<=500,request.prompt.length);assert.equal(request.context.length,39);assert.equal(request.options.length,3);
  for(const text of [input.successCriterion,input.units[0].description,input.arms[0].procedure])assert.ok(request.prompt.includes(text));
  assert.equal(request.data.allocation_hash,hash(allocation));
});

test('odd/out-of-range units, malformed arms, descriptions, indexes and unknown outcomes fail closed',async t=>{
  for(const mutate of [x=>{x.units=[];},x=>{x.units.pop();},x=>{x.units.push(...x.units,...x.units);},x=>{x.units[0].id=x.units[1].id;},
    x=>{x.units[0].id='constructor';},x=>{x.units[0].id='u'.repeat(25);},x=>{x.units[0].description='D'.repeat(71);},
    x=>{x.arms.pop();},x=>{x.arms[0].id='B';},x=>{x.arms[0].procedure=x.arms[1].procedure;},x=>{x.arms[0].label='L'.repeat(17);},
    x=>{x.arms[0].procedure='P'.repeat(71);},x=>{x.successCriterion='C'.repeat(71);},x=>{x.title='T'.repeat(33);},x=>{x.extra=true;},
    ...['',' leading','line\nline','line\rline','join\u200dtext','line\u2028text','\ud800'].map(text=>x=>{x.units[0].description=text;})]){
    const s=await setup(t);mutate(s.options.input);await assert.rejects(s.run());assert.equal(s.api.calls.length,0);assert.equal(s.draws.count,0);
  }
  const input=manifest(2),allocation=allocationFor(input,0);
  for(const index of [-1,2,1.1,'0',null,NaN])assert.throws(()=>allocationFor(input,index));
  for(const value of ['unknown',true,1,null,'passed'])assert.throws(()=>analyzePilot(input,allocation,{'unit-0':value,'unit-1':'success'}));
  assert.throws(()=>analyzePilot(input,allocation,{'unit-0,unit-1':'success'}));
  assert.throws(()=>analyzePilot(input,allocation,{'unit-0':'success'}));
});

test('allocate persists a bound journal and balanced state without a Question; all later operations reuse it',async t=>{
  const s=await setup(t);let total;
  const result=await s.run({command:'allocate',drawAllocation:count=>{total=count;return count-1;}});
  assert.equal(total,6);assert.equal(sends(s.api),0);assert.equal(result.status,'ready');assert.equal(result.allocation.index,5);
  const journal=await readJson(join(s.directory,'allocation.json'));assert.equal(journal.phase,'active');assert.deepEqual((await s.saved()).allocation,journal.allocation);
  const forbiddenDraw=()=>{throw new Error('must not redraw');};
  await s.run({command:'allocate',drawAllocation:forbiddenDraw});await s.run({drawAllocation:forbiddenDraw});
  const request=s.api.calls.find(call=>call.method==='POST').body;assert.equal(request.data.allocation_hash,hash(journal.allocation));
  await localReport(s.directory,s.options.input);assert.equal(sends(s.api),1);
});

test('allocation is durably active before the first outcome POST',async t=>{
  const s=await setup(t),ask=s.api.client.questions.ask.bind(s.api.client.questions);
  s.api.client.questions.ask=async(...args)=>{
    const journal=await readJson(join(s.directory,'allocation.json')),state=await s.saved();
    assert.equal(journal.phase,'active');assert.deepEqual(journal.allocation,state.allocation);
    assert.equal(state.attempts[0].status,'creating');return ask(...args);
  };
  await s.run();assert.equal(s.draws.count,1);assert.equal(sends(s.api),1);
});

test('crashes after saved allocation, empty state, or activation resume without redrawing',async t=>{
  for(const failStage of ['state','activation','after-activation']){
    const s=await setup(t);
    await assert.rejects(s.run({write:async(directory,name,value)=>{
      if(failStage==='state'&&name==='state.json'&&value.attempts.length===0)throw new Error('disk failure');
      if(failStage==='activation'&&name==='allocation.json'&&value.phase==='active')throw new Error('disk failure');
      await atomicJson(directory,name,value);
      if(failStage==='after-activation'&&name==='allocation.json'&&value.phase==='active')throw new Error('disk failure');
    }}),/disk failure/);
    const original=await readJson(join(s.directory,'allocation.json'));assert.equal(sends(s.api),0);assert.equal(s.draws.count,1);
    if(failStage==='state')assert.equal((await localReport(s.directory,s.options.input)).status,'allocation_prepared');
    await s.run({drawAllocation:()=>{throw new Error('redraw');}});assert.deepEqual((await s.saved()).allocation,original.allocation);assert.equal(sends(s.api),1);
  }
});

test('failed allocation persistence sends no Question and malformed random indexes are rejected',async t=>{
  const s=await setup(t);await assert.rejects(s.run({write:async()=>{throw new Error('disk failure');}}));assert.equal(sends(s.api),0);assert.equal(await s.saved(),null);
  for(const draw of [()=>-1,()=>99,()=>0.5,()=>Promise.resolve(0)]){
    const other=await setup(t);await assert.rejects(other.run({drawAllocation:draw}));assert.equal(sends(other.api),0);assert.equal(await other.saved(),null);
  }
});

test('active missing state, missing journal, corrupt allocation and changed connection cannot reset or redraw',async t=>{
  for(const mode of ['missing-state','missing-journal','changed-index','changed-assignment','changed-input','changed-token']){
    const s=await setup(t);await s.run({command:'allocate'});const before=s.api.calls.length;
    if(mode==='missing-state')await rm(join(s.directory,'state.json'));
    if(mode==='missing-journal')await rm(join(s.directory,'allocation.json'));
    if(mode==='changed-index'){const saved=await s.saved();saved.allocation.index=1;await atomicJson(s.directory,'state.json',saved);}
    if(mode==='changed-assignment'){const saved=await s.saved();saved.allocation.assignments[0].armId='B';await atomicJson(s.directory,'state.json',saved);}
    const extra={drawAllocation:()=>{throw new Error('redraw');}};
    if(mode==='changed-input'){extra.input=structuredClone(s.options.input);extra.input.successCriterion='Changed';}
    if(mode==='changed-token')extra.token='different';
    await assert.rejects(s.run(extra));assert.equal(s.api.calls.length,before);assert.equal(s.draws.count,1);
  }
});

test('allocation substitutions cannot recover a Question from a different assignment',async t=>{
  const s=await setup(t);s.api.controls.loseNext=true;await s.run();
  s.api.questions.get(id(1)).data.allocation_hash=hash(allocationFor(s.options.input,1));
  await assert.rejects(s.run({command:'recover',attachId:id(1)}));assert.equal(sends(s.api),1);assert.equal(s.draws.count,1);
});

test('complete pilot exports allocation, attributable outcomes and exact analysis as repeatable private JSON',async t=>{
  const input=manifest(),s=await setup(t,input),result=await decide(s,['success','success','success','success','failure','failure','failure','failure']);
  assert.equal(result.status,'complete');assert.deepEqual(result.analysis.randomization.pValue,{numerator:2,denominator:70,value:2/70});
  assert.equal(result.proceduresExecuted,false);assert.equal(result.winnerSelected,false);assert.equal(s.draws.count,1);assert.equal(sends(s.api),8);
  assert.ok(result.answers.every(answer=>answer.responderId===CONFIG.participant.id&&answer.askerId===ASKER));
  const calls=s.api.calls.length;await s.run({drawAllocation:()=>{throw new Error('redraw');}});assert.equal(s.api.calls.length,calls);
  await localReport(s.directory,input,{save:true});const exported=await exportPilot(s.directory,input),artifact=await readJson(exported.path);
  assert.equal(artifact.schemaVersion,1);assert.deepEqual(artifact.answers,result.answers);assert.deepEqual(artifact.allocation,result.allocation);
  const bytes=await readFile(exported.path);await exportPilot(s.directory,input);assert.deepEqual(await readFile(exported.path),bytes);
  assert.equal((await stat(exported.path)).mode&0o777,0o600);assert.equal((await stat(s.directory)).mode&0o777,0o700);
});

test('Unknown and failed outcomes block all analysis and export without dropping randomized units',async t=>{
  const s=await setup(t),result=await decide(s,['unknown','success','failure','success']);
  assert.equal(result.status,'incomplete');assert.equal(result.analysis,null);assert.deepEqual(result.unknownUnitIds,['card-01']);
  await assert.rejects(exportPilot(s.directory,s.options.input));assert.equal(s.draws.count,1);
  for(const terminal of ['expired','cancelled','invalid_answer']){
    const other=await setup(t);await other.run();
    if(terminal==='invalid_answer'){other.api.answer(id(1),'success');other.api.questions.get(id(1)).answer.responder.id=OTHER;}
    else{if(terminal==='expired')other.clock.value='2026-01-01T09:16:00.000Z';other.api.terminal(id(1),terminal);}
    assert.equal((await other.run()).observedStatus,terminal);
    const done=await decide(other,['success','failure','success']);assert.equal(done.status,'incomplete');assert.equal(done.analysis,null);
    await assert.rejects(exportPilot(other.directory,other.options.input));assert.equal(sends(other.api),4);assert.equal(other.draws.count,1);
  }
});

test('export refuses missing/pending/corrupt evidence and preserves previous output; locks cover export',async t=>{
  const s=await setup(t);await assert.rejects(exportPilot(s.directory,s.options.input));await s.run();await assert.rejects(exportPilot(s.directory,s.options.input));
  await atomicText(s.directory,'pilot-analysis.json','previous\n');await assert.rejects(exportPilot(s.directory,s.options.input));assert.equal(await readText(join(s.directory,'pilot-analysis.json')),'previous\n');
  const release=await acquireLock(s.directory);await assert.rejects(exportPilot(s.directory,s.options.input),/lock exists/);await release();
  const saved=await s.saved();saved.attempts[0].request.prompt='Changed';await atomicJson(s.directory,'state.json',saved);await assert.rejects(exportPilot(s.directory,s.options.input));
});

test('newline-suffixed IDs, UUIDs, room codes and credentials fail before API or allocation',async t=>{
  for(const suffix of ['\n','\r','\r\n','\u2028','\u2029']){
    assert.equal(ROOM.test(ROOM_CODE+suffix),false);assert.equal(isId(CONFIG.participant.id+suffix),false);assert.throws(()=>iso('2026-01-01T09:00:00.000Z'+suffix));
    assert.throws(()=>validateConnection({token:'token'+suffix,room:ROOM_CODE}));assert.throws(()=>validateConnection({token:'token',room:ROOM_CODE+suffix}));
    for(const mutate of [x=>{x.pilotId+=suffix;},x=>{x.units[0].id+=suffix;}]){const s=await setup(t);mutate(s.options.input);await assert.rejects(s.run());assert.equal(s.api.calls.length,0);assert.equal(s.draws.count,0);}
    const s=await setup(t);await assert.rejects(s.run({token:'token'+suffix}));await assert.rejects(s.run({room:ROOM_CODE+suffix}));
    await assert.rejects(s.run({config:{participant:{id:CONFIG.participant.id+suffix,label:'Operator'}}}));assert.equal(s.api.calls.length,0);assert.equal(s.draws.count,0);
  }
});

test('manifest content, operator and connection stay immutable; canonical array permutations resume', async t => {
  const s = await setup(t); await s.run({command:'allocate'}); const allocation = (await s.saved()).allocation;
  for (const mutate of [input=>{input.title='Changed';},input=>{input.arms[0].procedure='Different task';},
    input=>{input.units[0].description='Different unit';},input=>{input.units[0].id='different';}]) {
    const input=structuredClone(s.options.input);mutate(input);const before=s.api.calls.length;
    await assert.rejects(s.run({input}));assert.equal(s.api.calls.length,before);
  }
  await assert.rejects(s.run({config:{participant:{id:OTHER,label:'Other'}}}));
  await assert.rejects(s.run({room:'OTHER1234567'}));
  const reordered=structuredClone(s.options.input);reordered.arms.reverse();reordered.units.reverse();
  const result=await s.run({input:reordered,drawAllocation:()=>{throw new Error('redraw');}});
  assert.deepEqual(result.allocation,allocation);assert.equal(sends(s.api),1);
});

test('the pinned SDK transports the complete maximum Unicode outcome prompt', async t => {
  const input=manifest(2);input.title='😀'.repeat(16);input.successCriterion='😀'.repeat(35);
  input.units[0].description='😀'.repeat(35);input.arms[0]={id:'A',label:'😀'.repeat(8),procedure:'😀'.repeat(35)};
  const s=await setup(t,input);await s.run();const request=s.api.calls.find(call=>call.method==='POST').body;
  assert.ok(request.prompt.length<=500);assert.equal(request.context.length,39);
  for(const text of [input.title,input.successCriterion,input.units[0].description,input.arms[0].procedure])assert.ok(request.prompt.includes(text));
});

test('private JSON output is bounded and export never writes through a destination symlink',async t=>{
  const s=await setup(t);await decide(s,['success','success','success','success']);
  const outside=join(s.directory,'outside.json');await writeFile(outside,'keep');
  await symlink(outside,join(s.directory,'pilot-analysis.json'));await exportPilot(s.directory,s.options.input);
  assert.equal((await readJson(join(s.directory,'pilot-analysis.json'))).status,'complete');
  assert.equal(await readFile(outside,'utf8'),'keep');
  await assert.rejects(atomicJson(s.directory,'oversized.json',{data:'x'.repeat(1024*1024)}),/size limit/);
});
