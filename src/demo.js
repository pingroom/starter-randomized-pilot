import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './storage.js';
import { step, exportPilot } from './engine.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';

const example = await readJson(new URL('../examples/pilot.json', import.meta.url), 65536);
for (const [label, outcomes] of [
  ['Equal recorded rates', ['success', 'failure', 'success', 'failure']],
  ['Different recorded rates', ['success', 'success', 'failure', 'failure']],
  ['Unknown blocks analysis', ['success', 'unknown', 'failure', 'failure']],
]) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-pilot-demo-'));
  const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
  const options = { client: api.client, directory, input: example, config: CONFIG,
    token: 'offline-fixture-token', room: ROOM_CODE, now, drawAllocation: () => 0 };
  try {
    const allocated = await step({ ...options, command: 'allocate' });
    let result;
    for (const value of outcomes) {
      const pending = await step(options);
      api.answer(pending.answers.find(answer => answer.status === 'pending').questionId, value);
      result = await step(options);
    }
    if (result.status === 'complete') await exportPilot(directory, example);
    console.log(JSON.stringify({ label, transport: 'local mock; no procedures performed or live pings sent',
      allocation: allocated.allocation.assignments, outcomes, status: result.status,
      difference: result.analysis?.difference ?? null, pValue: result.analysis?.randomization.pValue ?? null }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
