import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { bounded, childCall, createFixture, texts } from './runtime-fixture.mjs';

const until = (condition, label) => bounded((async () => {
  while (!(await condition())) await delay(2);
})(), label);
const prompt = (agent, text) => agent.followup({ content: [{ type: 'text', text }], source: { kind: 'user' } });
const start = (fixture, parent, label, delivery = 'caller') => fixture.ctx.subagents.startActivation({
  provider: 'spawn', label, delivery, signal: new AbortController().signal,
  request: { parent, maxDepth: 5, prompt: [{ type: 'text', text: label }] },
});

async function registerTool(fixture, name, execute) {
  await fixture.ctx.plugin({ name: `test-${name}`, inject: ['tools'], apply(ctx) {
    ctx.tools.register(defineTool({ name, description: name, parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(_args, exec) { return execute(exec); },
    }));
  } });
}

test('single channel: failed dispatch creates no phantom child and does not strand a valid sibling', { timeout: 20000 }, async t => {
  const fixture = await createFixture({ name: 'dispatch-failure', policy: async request => {
    if (!request.parentId && request.count === 1) return [
      { type: 'tool-call', id: 'bad-dispatch', name: 'subagent', arguments: '{"description":"missing prompt"}' },
      childCall('valid-sibling'),
    ];
    return 'DONE';
  } });
  t.after(() => fixture.close());
  const root = await fixture.createRoot('dispatch-failure');
  await assert.rejects(fixture.ctx.subagents.startActivation({
    provider: 'missing-provider', label: 'not-started', delivery: 'caller', signal: new AbortController().signal,
    request: { parent: root, maxDepth: 5, prompt: [{ type: 'text', text: 'invalid provider' }] },
  }));
  assert.equal((await fixture.ctx.sessionConcurrency.get({ sessionId: root.id })).trackedChildren, 0);
  prompt(root, 'Recover from invalid dispatch.');
  await bounded(fixture.settle(root), 'failed dispatch recovery');
  assert.equal(fixture.trace.filter(event => event.type === 'subagent/start').length, 1);
  assert.equal(fixture.calls.get(root.id), 2);
  const state = await fixture.ctx.sessionConcurrency.get({ sessionId: root.id });
  assert.deepEqual([state.active, state.queued, state.waiting, state.trackedChildren], [0, 0, 0, 0]);
});

test('single channel: native batch dispatch stays below even one resident child slot', { timeout: 20000 }, async t => {
  const fixture = await createFixture({ name: 'dispatch-slots', maxActiveSubagents: 1, policy: async request => {
    if (!request.parentId && request.count === 1) return ['first', 'second', 'third'].map(label => childCall(label));
    return request.parentId ? 'SLOT_CHILD_DONE' : 'ALL_DONE';
  } });
  t.after(() => fixture.close());
  const root = await fixture.createRoot('dispatch-slots');
  prompt(root, 'Delegate three tasks.');
  await bounded(fixture.settle(root), 'dispatch batch at capacity one');
  const events = fixture.trace.filter(event => event.type.startsWith('subagent/'));
  assert.deepEqual(events.map(event => event.type), Array.from({ length: 3 }, () => ['subagent/start', 'subagent/end']).flat());
  assert.equal(fixture.calls.get(root.id), 2);
  assert.equal(fixture.peaks.get(root.id), 1);
});

test('single channel: whole internal branches run serially across tool I/O and nested delegation', { timeout: 20000 }, async t => {
  const fixture = await createFixture({ name: 'branches', policy: async request => {
    if (request.parentId && request.text.includes('BRANCH_A') && request.count === 1)
      return [{ type: 'tool-call', id: 'slow-io', name: 'slow_io', arguments: '{}' }];
    if (request.parentId && request.text.includes('BRANCH_A') && request.count === 2)
      return [childCall('grandchild', 'GRANDCHILD')];
    return 'BRANCH_DONE';
  } });
  t.after(() => fixture.close());
  await registerTool(fixture, 'slow_io', async () => { await delay(60); return 'IO_DONE'; });
  const root = await fixture.createRoot('branches');
  const a = await start(fixture, root, 'BRANCH_A');
  const b = await start(fixture, root, 'BRANCH_B');
  await bounded(Promise.all([a.result, b.result]), 'serial internal branches');
  const aEnd = fixture.trace.find(event => event.type === 'subagent/end' && event.id === a.childId);
  const bStart = fixture.trace.find(event => event.type === 'model/start' && event.id === b.childId);
  assert.ok(bStart.sequence > aEnd.sequence, 'Sibling must not take the branch during A’s tools or grandchild.');
  assert.equal(fixture.trace.filter(event => event.type === 'subagent/end').length, 3);
  assert.equal(fixture.peaks.get(root.id), 1);
  assert.equal(fixture.calls.get(root.id) ?? 0, 0, 'Caller delivery must not wake the parent model.');
});

for (const fails of [false, true]) test(`single channel: ClearAI-style caller audit ${fails ? 'failure' : 'success'} returns to its tool without duplicate parent delivery`, { timeout: 20000 }, async t => {
  const fixture = await createFixture({ name: 'caller-audit', policy: async request => {
    if (request.parentId) {
      if (fails) throw new Error('Intentional audit model failure');
      return 'INDEPENDENT_AUDIT_RESULT';
    }
    if (request.count === 1) return [{ type: 'tool-call', id: 'audit-call', name: 'audit', arguments: '{}' }];
    return 'PARENT_AFTER_AUDIT';
  } });
  t.after(() => fixture.close());
  let terminal;
  await registerTool(fixture, 'audit', async exec => {
    const receipt = await start(fixture, exec.agent, 'AUDIT_TASK');
    terminal = await receipt.result;
    return `AUDIT_TOOL:${terminal.stopReason}:${texts([{ content: terminal.output }])}`;
  });
  const root = await fixture.createRoot(`audit-${fails}`);
  prompt(root, 'Submit for an independent audit.');
  await bounded(fixture.settle(root), 'caller audit');
  assert.equal(terminal.stopReason, fails ? 'error' : 'completed');
  assert.equal(fixture.calls.get(root.id), 2, 'Exactly one result-aware parent continuation.');
  const continuation = fixture.trace.find(event => event.type === 'model/start' && event.id === root.id && event.count === 2);
  assert.ok(continuation.text.includes(`AUDIT_TOOL:${fails ? 'error' : 'completed'}`));
  const state = await fixture.ctx.sessionConcurrency.get({ sessionId: root.id });
  assert.equal(state.trackedChildren, 0);
  assert.equal(state.active, 0);
});

test('single channel: rules reach first parent and child requests, update with limits, and leave default alone', { timeout: 20000 }, async t => {
  const fixture = await createFixture({ name: 'instructions', policy: async request => {
    if (!request.parentId && request.count === 1) return [childCall('instructions-child')];
    return 'DONE';
  } });
  t.after(() => fixture.close());
  const root = await fixture.createRoot('instructions');
  prompt(root, 'Do one task.');
  await bounded(fixture.settle(root), 'instruction delivery');
  for (const event of fixture.trace.filter(event => event.type === 'model/start')) {
    assert.ok(event.text.includes('单通道串行模式'));
    assert.ok(event.text.includes('不存在的子 Agent'));
    assert.ok(event.text.includes('独立审核'));
  }
  await fixture.ctx.sessionConcurrency.set({ sessionId: root.id, limit: 2 });
  const assembly = await fixture.ctx.systemPrompt.assemble({ agent: root, scope: root });
  assert.match(assembly.contexts.find(section => section.name === 'session-concurrency:runtime').text, /共用 2 条/);
  await fixture.ctx.sessionConcurrency.set({ sessionId: root.id, limit: null });
  const defaults = await fixture.ctx.systemPrompt.assemble({ agent: root, scope: root });
  assert.equal(defaults.contexts.find(section => section.name === 'session-concurrency:runtime').text, '');
});

test('single channel: installing during an existing activation adopts it and waits for its actual result', { timeout: 20000 }, async t => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const fixture = await createFixture({ name: 'adoption', installPlugin: false, policy: async request => {
    if (request.parentId) { await hold; return 'ADOPTED_RESULT'; }
    return 'AFTER_ADOPTION';
  } });
  t.after(async () => { release(); await fixture.close(); });
  const root = await fixture.createRoot('adoption');
  const child = await start(fixture, root, 'existing', 'parent');
  await until(() => fixture.calls.has(child.childId), 'existing child inference');
  await fixture.installConcurrencyPlugin();
  await fixture.ctx.sessionConcurrency.set({ sessionId: root.id, limit: 1 });
  const initial = await fixture.ctx.sessionConcurrency.get({ sessionId: root.id });
  assert.equal(initial.trackedChildren, 1);
  prompt(root, 'Collect the already running child.');
  await delay(25);
  assert.equal(fixture.calls.get(root.id) ?? 0, 0);
  release();
  await bounded(fixture.settle(root), 'adopted result delivery');
  const continuations = fixture.trace.filter(event => event.type === 'model/start' && event.id === root.id);
  const ended = fixture.trace.find(event => event.type === 'subagent/end' && event.id === child.childId);
  assert.ok(continuations[0].sequence > ended.sequence);
  // DSH claims inbox messages before pre-step hooks. A turn already claimed
  // while this plugin was being installed may consume the native result at
  // the following boundary. Do not rewrite or duplicate that native inbox.
  assert.ok(continuations.some(event => event.text.includes('ADOPTED_RESULT')));
  assert.equal((await fixture.ctx.sessionConcurrency.get({ sessionId: root.id })).trackedChildren, 0);
});

test('single channel: a lost lifecycle end is recovered from the exact native result promise', { timeout: 20000 }, async t => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const fixture = await createFixture({ name: 'missed-end', policy: async request => {
    if (request.parentId) await hold;
    return 'ACTUAL_RESULT';
  } });
  t.after(async () => { release(); await fixture.close(); });
  const root = await fixture.createRoot('missed-end');
  const receipt = await start(fixture, root, 'child', 'parent');
  const activation = fixture.ctx.subagents.manager.resident.get(receipt.childId);
  activation.observer.settle = () => fixture.record('test/dropped-end');
  prompt(root, 'Collect the result.');
  await delay(20);
  assert.equal(fixture.calls.get(root.id) ?? 0, 0);
  release();
  await bounded(fixture.settle(root), 'missing lifecycle end recovery');
  assert.equal((await fixture.ctx.sessionConcurrency.get({ sessionId: root.id })).trackedChildren, 0);
  assert.ok(fixture.trace.some(event => event.type === 'test/dropped-end'));
  assert.ok(fixture.trace.some(event => event.type === 'model/start' && event.id === root.id));
});

test('single channel: an interrupted child with parked input neither blocks forever nor restarts itself', { timeout: 20000 }, async t => {
  const fixture = await createFixture({ name: 'parked-child', policy: async (request, { delay }) => {
    if (request.parentId) await delay(1000);
    return 'DONE';
  } });
  t.after(() => fixture.close());
  const root = await fixture.createRoot('parked-child');
  const receipt = await start(fixture, root, 'pause-me');
  await until(() => fixture.calls.has(receipt.childId), 'running child');
  const child = fixture.ctx.agents.get(receipt.childId);
  child.inject({ content: [{ type: 'text', text: 'Keep this input parked until explicitly resumed.' }], source: { kind: 'user' } });
  fixture.ctx.subagents.interrupt(receipt.childId, { kind: 'ancestor', agent: root });
  await bounded(child.whenIdle(), 'child interruption');
  const state = await fixture.ctx.sessionConcurrency.get({ sessionId: root.id });
  assert.equal(state.parkedChildren, 1);
  prompt(root, 'Explain what remains paused.');
  await bounded(root.whenIdle(), 'parent with parked child');
  assert.equal(fixture.calls.get(receipt.childId), 1, 'The plugin must not wake explicitly parked input.');
  assert.equal(fixture.calls.get(root.id), 1);
  assert.ok(fixture.trace.find(event => event.type === 'model/start' && event.id === root.id).text.includes('没有自动重启'));
  await receipt.dispose();
});

test('plugin reload counts and waits for a real stream admitted by the previous generation', { timeout: 20000 }, async t => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const fixture = await createFixture({ name: 'stream-reload', policy: async request => {
    if (request.count === 1) await hold;
    return 'DONE';
  } });
  t.after(async () => { release(); await fixture.close(); });
  const root = await fixture.createRoot('stream-reload');
  const dispatch = async () => {
    for await (const chunk of fixture.ctx.llm.stream({ provider: 'offline-test', model: 'deterministic', sessionId: root.id,
      signal: new AbortController().signal, messages: [{ role: 'user', content: [{ type: 'text', text: 'work' }] }] })) { /* drain */ }
  };
  const first = dispatch();
  await until(() => fixture.calls.get(root.id) === 1, 'first stream');
  await fixture.reloadPlugin();
  assert.equal((await fixture.ctx.sessionConcurrency.get({ sessionId: root.id })).active, 1);
  const second = dispatch();
  await delay(25);
  assert.equal(fixture.calls.get(root.id), 1);
  release();
  await bounded(Promise.all([first, second]), 'streams across reload');
  assert.equal(fixture.peaks.get(root.id), 1);
});

test('single channel: cancelling a batch does not start its queued delegations later', { timeout: 20000 }, async t => {
  const fixture = await createFixture({ name: 'cancel-batch', policy: async (request, { delay }) => {
    if (!request.parentId && request.count === 1) return ['slow', 'never-1', 'never-2'].map(label => childCall(label));
    if (request.parentId) await delay(100);
    return 'DONE';
  } });
  t.after(() => fixture.close());
  const root = await fixture.createRoot('cancel-batch');
  prompt(root, 'Run three children.');
  await until(() => fixture.trace.some(event => event.type === 'model/start' && event.parentId), 'first child');
  root.cancel({ kind: 'user' });
  await bounded(fixture.settle(root), 'cancelled batch');
  assert.equal(fixture.trace.filter(event => event.type === 'subagent/start').length, 1);
  assert.equal((await fixture.ctx.sessionConcurrency.get({ sessionId: root.id })).trackedChildren, 0);
});
