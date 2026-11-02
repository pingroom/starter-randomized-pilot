import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const preload = String.raw`
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const store = process.env.PROBE_STORE;
const questions = existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : [];
const save = () => writeFileSync(store, JSON.stringify(questions));
globalThis.fetch = async (raw, init) => {
  if (process.env.PROBE_OFFLINE === 'yes') throw new Error('Unexpected network operation');
  const url = new URL(raw), path = url.pathname;
  if (url.origin !== 'https://api.pingroom.io') throw new Error('Unexpected mock origin');
  appendFileSync(process.env.PROBE_LOG, JSON.stringify({method:init.method,path}) + '\n');
  const participant = '11111111-1111-4111-8111-111111111111';
  if (init.method === 'GET' && path === '/api/agent/rooms') return Response.json([
    {invite_code:'DEMO12345678',type:'standard',is_public:false,members:[{user_id:participant}]}
  ]);
  if (init.method === 'POST' && path === '/api/agent/rooms/DEMO12345678/questions') {
    const body = JSON.parse(init.body), now = new Date().toISOString();
    const question = {id:'01990000-0000-7000-8000-' + String(questions.length+1).padStart(12,'0'),
      kind:'question',is_handoff:false,prompt:body.prompt,context:body.context,
      options:body.options.map(({value,label})=>({value,label,primary:false,destructive:false})),
      text_input:null,responder_scope:'direct',target_user_id:participant,resolution_policy:'first',
      state:'pending',results:null,answer:null,expires_at:new Date(Date.parse(now)+900000).toISOString(),
      resolved_at:null,correlation_id:body.correlation_id,reply_to:null,data:body.data,created_at:now,
      room_code:'DEMO12345678',room:{code:'DEMO12345678'},asker:{type:'agent',id:'33333333-3333-4333-8333-333333333333'}};
    questions.push(question); save();
    if(process.env.PROBE_LOST === 'yes') throw new Error('Lost response after POST');
    return Response.json(question,{status:201});
  }
  if (init.method === 'GET' && path === '/api/agent/questions') return Response.json({questions});
  const q = questions.find(q=>path === '/api/agent/questions/' + q.id);
  if (init.method === 'GET' && q) {
    if (process.env.PROBE_CANCEL === 'yes' && q.state === 'pending') { q.state = 'cancelled'; q.resolved_at = new Date().toISOString(); save(); }
    const value = process.env.PROBE_ANSWER;
    if (value && q.state === 'pending') {
      q.state='answered';q.resolved_at=new Date().toISOString();
      q.answer={value,label:q.options.find(o=>o.value===value).label,text:null,responder:{id:participant},answered_at:q.resolved_at};save();
    }
    return Response.json(q);
  }
  throw new Error('Unexpected mock request');
};
`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(),'pilot-cli-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await cp(join(source,'src'),join(directory,'src'),{recursive:true});
  await cp(join(source,'package.json'),join(directory,'package.json'));
  await cp(join(source,'config.example.json'),join(directory,'config.json'));
  const input=JSON.parse(await readFile(join(source,'examples/pilot.json'),'utf8'));
  await writeFile(join(directory,'pilot.json'),JSON.stringify(input));
  await symlink(join(source,'node_modules'),join(directory,'node_modules'));
  await writeFile(join(directory,'preload.mjs'),preload);
  return directory;
}
function cli(directory,command='run',{answer='',lost=false,cancel=false,offline=false,argument,envOverride={}}={}) {
  const env={...process.env,PINGROOM_TOKEN:'offline-fixture-token',PINGROOM_ROOM:'DEMO12345678',
    PROBE_STORE:join(directory,'questions.json'),PROBE_LOG:join(directory,'requests.jsonl'),
    PROBE_ANSWER:answer,PROBE_CANCEL:cancel?'yes':'no',PROBE_LOST:lost?'yes':'no',PROBE_OFFLINE:offline?'yes':'no'};
  Object.assign(env,envOverride);
  for(const key of Object.keys(env))if(env[key]===undefined)delete env[key];
  delete env.NODE_OPTIONS;
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--import',join(directory,'preload.mjs'),join(directory,'src/cli.js'),command,...(argument?[argument]:[])],{cwd:tmpdir(),env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',x=>{stdout+=x;});child.stderr.on('data',x=>{stderr+=x;});
    const timer=setTimeout(()=>child.kill('SIGKILL'),8000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr,json:stdout.trim().startsWith('{')?JSON.parse(stdout):null});});
  });
}
const requests=async directory=>(await readFile(join(directory,'requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
const posts=async directory=>(await requests(directory)).filter(c=>c.method==='POST').length;

async function expect(directory,command,options,code,status) {
  const result=await cli(directory,command,options);
  assert.equal(result.code,code,result.stderr||result.stdout);assert.equal(result.json.status,status);return result.json;
}





async function complete(directory, values = ['success', 'success', 'success', 'success']) {
  let result;
  for (let index = 0; index < values.length; index++) {
    await expect(directory, 'run', {}, 3, 'pending');
    const finished = index === values.length - 1;
    const known = values.every(value => value !== 'unknown');
    result = await expect(directory, 'run', { answer: values[index] }, finished ? known ? 0 : 2 : 3, finished ? known ? 'complete' : 'incomplete' : 'ready');
  }
  return result;
}

test('CLI allocates before procedures, reuses allocation across processes, and exports complete offline analysis', async t => {
  const directory = await fixture(t), preview = await cli(directory, 'preview', { offline: true });
  assert.equal(preview.code, 0, preview.stderr); assert.equal(preview.json.units.length, 4);
  const sourceBytes = await readFile(join(directory, 'pilot.json'));
  const allocated = await expect(directory, 'allocate', {}, 0, 'ready');
  assert.equal(await posts(directory), 0); assert.equal(allocated.allocation.assignments.filter(item => item.armId === 'A').length, 2);
  const journal = await readFile(join(directory, '.pilot/allocation.json'));
  const again = await expect(directory, 'allocate', { offline: true }, 0, 'ready'); assert.deepEqual(again.allocation, allocated.allocation);
  const result = await complete(directory);
  assert.deepEqual(result.allocation, allocated.allocation); assert.deepEqual(await readFile(join(directory, '.pilot/allocation.json')), journal);
  assert.equal(result.analysis.randomization.pValue.value, 1); assert.equal(result.analysis.difference.value, 0); assert.equal(await posts(directory), 4);
  await expect(directory, 'run', { offline: true }, 0, 'complete');
  const saved = await expect(directory, 'report', { offline: true }, 0, 'complete');
  assert.deepEqual(JSON.parse(await readFile(join(directory, '.pilot/report.json'), 'utf8')), saved);
  const exported = await expect(directory, 'export', { offline: true, envOverride: { PINGROOM_TOKEN: undefined, PINGROOM_ROOM: undefined } }, 0, 'complete');
  assert.equal(exported.inputHash, result.inputHash); assert.equal(exported.allocationHash, result.allocationHash);
  const output = await readFile(exported.path, 'utf8'), artifact = JSON.parse(output);
  assert.equal(artifact.schemaVersion, 1); assert.deepEqual(artifact.answers, result.answers); assert.equal(artifact.proceduresExecuted, false);
  await expect(directory, 'export', { offline: true }, 0, 'complete'); assert.equal(await readFile(exported.path, 'utf8'), output);
  assert.deepEqual(await readFile(join(directory, 'pilot.json')), sourceBytes);
});

test('CLI blocks Unknown and cancelled outcomes without reasking or dropping units', async t => {
  const directory = await fixture(t);
  assert.equal((await cli(directory, 'export', { offline: true })).code, 1);
  const result = await complete(directory, ['success', 'unknown', 'failure', 'success']);
  assert.equal(result.analysis, null); assert.deepEqual(result.unknownUnitIds, ['card-02']); assert.equal(result.answers.length, 4);
  assert.equal((await cli(directory, 'export', { offline: true })).code, 1);
  await expect(directory, 'run', { offline: true }, 2, 'incomplete'); assert.equal(await posts(directory), 4);
  const failed = await fixture(t);
  await expect(failed, 'run', {}, 3, 'pending'); assert.equal((await cli(failed, 'export', { offline: true })).code, 1);
  await expect(failed, 'run', { cancel: true }, 2, 'ready');
  for (let index = 0; index < 3; index++) {
    await expect(failed, 'run', {}, 3, 'pending');
    await expect(failed, 'run', { answer: 'success' }, index === 2 ? 2 : 3, index === 2 ? 'incomplete' : 'ready');
  }
  assert.equal((await cli(failed, 'export', { offline: true })).code, 1);
  await assert.rejects(readFile(join(failed, '.pilot/pilot-analysis.json')), { code: 'ENOENT' });
  assert.equal(await posts(failed), 4);
});

test('CLI recovers the original uncertain Question without another allocation or POST', async t => {
  const directory = await fixture(t);
  const first = await expect(directory, 'run', { lost: true }, 4, 'create_unknown');
  await expect(directory, 'run', { offline: true }, 4, 'create_unknown');
  const found = await expect(directory, 'find', {}, 4, 'create_unknown'); assert.equal(found.candidates.length, 1);
  const qid = found.candidates[0].id;
  const ready = await expect(directory, 'recover', { argument: qid, answer: 'success' }, 3, 'ready');
  assert.equal(ready.answers[0].questionId, qid); assert.equal(await posts(directory), 1); assert.deepEqual(ready.allocation, first.allocation);
  const pending = await expect(directory, 'run', {}, 3, 'pending'); assert.deepEqual(pending.allocation, first.allocation);
  await expect(directory, 'run', { answer: 'failure' }, 3, 'ready'); assert.equal(await posts(directory), 2);
});

test('CLI resumes a prepared allocation but refuses active missing state or a missing journal before requests', async t => {
  const directory = await fixture(t), first = await expect(directory, 'allocate', {}, 0, 'ready');
  const journalPath = join(directory, '.pilot/allocation.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')); journal.phase = 'prepared';
  await writeFile(journalPath, JSON.stringify(journal)); await rm(join(directory, '.pilot/state.json'));
  const prepared = await expect(directory, 'status', { offline: true }, 0, 'allocation_prepared'); assert.deepEqual(prepared.allocation, first.allocation);
  const resumed = await expect(directory, 'allocate', { offline: true }, 0, 'ready'); assert.deepEqual(resumed.allocation, first.allocation);
  const before = (await requests(directory)).length;
  await rm(join(directory, '.pilot/state.json'));
  assert.equal((await cli(directory, 'allocate')).code, 1); assert.equal((await requests(directory)).length, before);
  const other = await fixture(t); await expect(other, 'allocate', {}, 0, 'ready'); const otherBefore = (await requests(other)).length;
  await rm(join(other, '.pilot/allocation.json'));
  assert.equal((await cli(other, 'run')).code, 1); assert.equal((await requests(other)).length, otherBefore);
});

test('CLI rejects partial and newline-suffixed credentials before requests; complete dotenv setup works', async t => {
  const directory = await fixture(t);
  await writeFile(join(directory, '.env'), 'PINGROOM_TOKEN=dotenv-fixture\nPINGROOM_ROOM=DEMO12345678\n');
  for (const envOverride of [{ PINGROOM_TOKEN: 'external', PINGROOM_ROOM: undefined }, { PINGROOM_TOKEN: 'external\n' }, { PINGROOM_ROOM: 'DEMO12345678\r\n' }]) {
    const invalid = await cli(directory, 'allocate', { envOverride }); assert.equal(invalid.code, 1);
    await assert.rejects(readFile(join(directory, 'requests.jsonl')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(directory, '.pilot/allocation.json')), { code: 'ENOENT' });
  }
  await expect(directory, 'allocate', { envOverride: { PINGROOM_TOKEN: undefined, PINGROOM_ROOM: undefined } }, 0, 'ready');
});

test('CLI rejects invalid arguments and changed fixed manifest before new requests or export', async t => {
  const directory = await fixture(t);
  for (const [command, argument] of [['recover', 'not-a-uuid'], ['recover', '11111111-1111-4111-8111-111111111111\n'], ['export', 'unexpected'], ['allocate', 'unexpected']]) {
    assert.equal((await cli(directory, command, { argument, offline: true })).code, 1);
  }
  await expect(directory, 'allocate', {}, 0, 'ready');
  const input = JSON.parse(await readFile(join(directory, 'pilot.json'), 'utf8')); input.successCriterion = 'Changed criterion';
  await writeFile(join(directory, 'pilot.json'), JSON.stringify(input)); const before = (await requests(directory)).length;
  assert.equal((await cli(directory, 'run')).code, 1); assert.equal((await requests(directory)).length, before);
  assert.equal((await cli(directory, 'export', { offline: true })).code, 1);
});
