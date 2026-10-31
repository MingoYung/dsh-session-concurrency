import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { bounded, childCall, createFixture } from './runtime-fixture.mjs';

test('actual DSH runtime: one permit serializes children and resumes parent with all results', { timeout: 20000 }, async t => {
  const fixture = await createFixture({ name: 'serial', policy: async (request, { delay }) => {
    if (!request.parentId && request.count === 1) return [childCall('alpha'), childCall('beta'), childCall('gamma')];
    if (request.parentId) { await delay(35); return `CHILD_RESULT:${request.text.match(/alpha|beta|gamma/)?.[0]}`; }
    return 'PARENT_SUMMARY';
  } });
  t.after(() => fixture.close());
  const root = await fixture.createRoot('root-serial');
  root.followup({ content: [{ type: 'text', text: 'Please delegate three tasks.' }], source: { kind: 'user' } });
  await bounded(fixture.settle(root), 'serial delegation');
  const rootCalls = fixture.trace.filter(event => event.type === 'model/start' && event.id === root.id);
  const childEnds = fixture.trace.filter(event => event.type === 'subagent/end');
  assert.equal(childEnds.length, 3, JSON.stringify(fixture.trace));
  assert.equal(rootCalls.length, 2, 'One initial request and one result-aware summary request are expected.');
  assert.ok(rootCalls[1].sequence > Math.max(...childEnds.map(event => event.sequence)), 'Parent must resume only after all child activations settle.');
  for (const label of ['alpha', 'beta', 'gamma']) assert.ok(rootCalls[1].text.includes(`CHILD_RESULT:${label}`), `First parent continuation must include ${label}'s result.`);
  assert.equal(fixture.peaks.get(root.id), 1);
  assert.equal((await fixture.ctx.sessionConcurrency.get({ sessionId: root.id })).active, 0);
});

test('actual DSH runtime: two permits allow children to overlap without exceeding the tree limit', { timeout: 20000 }, async t => {
  const fixture = await createFixture({ name: 'parallel', limit: 2, policy: async (request, { delay }) => {
    if (!request.parentId && request.count === 1) return ['a', 'b', 'c', 'd'].map(label => childCall(label));
    if (request.parentId) { await delay(60); return 'CHILD_DONE'; }
    return 'PARENT_DONE';
  } });
  t.after(() => fixture.close());
  const root = await fixture.createRoot('root-parallel');
  root.followup({ content: [{ type: 'text', text: 'Run four children.' }], source: { kind: 'user' } });
  await bounded(fixture.settle(root), 'parallel delegation');
  assert.equal(fixture.trace.filter(event => event.type === 'subagent/end').length, 4);
  assert.equal(fixture.peaks.get(root.id), 2, 'Two children should overlap while the root waits.');
  assert.equal((await fixture.ctx.sessionConcurrency.get({ sessionId: root.id })).queued, 0);
});

test('actual DSH runtime: independent root sessions each retain their own quota', { timeout: 20000 }, async t => {
  const fixture = await createFixture({ name: 'isolation', policy: async (_request, { delay }) => { await delay(80); return 'DONE'; } });
  t.after(() => fixture.close());
  const local = await fixture.createRoot('root-local', 1);
  const cloud = await fixture.createRoot('root-cloud', 3);
  for (const agent of [local, cloud]) agent.followup({ content: [{ type: 'text', text: 'Work independently.' }], source: { kind: 'user' } });
  await bounded(Promise.all([fixture.settle(local), fixture.settle(cloud)]), 'independent sessions');
  assert.equal(fixture.maximum(), 2, 'Separate chats must not share a global semaphore.');
  assert.equal((await fixture.ctx.sessionConcurrency.get({ sessionId: local.id })).limit, 1);
  assert.equal((await fixture.ctx.sessionConcurrency.get({ sessionId: cloud.id })).limit, 3);
});

test('actual DSH runtime: nested delegation yields the only permit and returns to both ancestors', { timeout: 20000 }, async t => {
  const fixture = await createFixture({ name: 'nested', policy: async (request, { delay }) => {
    if (!request.parentId && request.count === 1) return [childCall('level-one', 'LEVEL_ONE')];
    if (request.parentId && request.text.includes('LEVEL_ONE') && request.count === 1) return [childCall('level-two', 'LEVEL_TWO')];
    await delay(20);
    return request.parentId ? 'NESTED_RESULT' : 'ROOT_RESULT';
  } });
  t.after(() => fixture.close());
  const root = await fixture.createRoot('root-nested');
  root.followup({ content: [{ type: 'text', text: 'Create a nested task.' }], source: { kind: 'user' } });
  await bounded(fixture.settle(root), 'nested delegation');
  assert.equal(fixture.trace.filter(event => event.type === 'subagent/end').length, 2, JSON.stringify(fixture.trace));
  assert.equal(fixture.peaks.get(root.id), 1);
  const rootCalls = fixture.trace.filter(event => event.type === 'model/start' && event.id === root.id);
  assert.equal(rootCalls.length, 2);
  assert.ok(rootCalls[1].text.includes('NESTED_RESULT'));
});

test('actual DSH runtime: a child model failure releases quota and wakes its parent', { timeout: 20000 }, async t => {
  const fixture = await createFixture({ name: 'failure', policy: async (request, { delay }) => {
    if (!request.parentId && request.count === 1) return [childCall('fails'), childCall('succeeds')];
    if (request.parentId) {
      await delay(25);
      if (request.text.includes('fails')) throw new Error('Expected offline child failure.');
      return 'SURVIVOR_RESULT';
    }
    return 'PARENT_HANDLED_FAILURE';
  } });
  t.after(() => fixture.close());
  const root = await fixture.createRoot('root-failure');
  root.followup({ content: [{ type: 'text', text: 'Delegate one failing and one successful child.' }], source: { kind: 'user' } });
  await bounded(fixture.settle(root), 'child failure recovery');
  assert.equal(fixture.trace.filter(event => event.type === 'subagent/end').length, 2);
  assert.equal(fixture.peaks.get(root.id), 1);
  const continuation = fixture.trace.find(event => event.type === 'model/start' && event.id === root.id && event.count === 2);
  assert.ok(continuation?.text.includes('SURVIVOR_RESULT'));
  assert.equal((await fixture.ctx.sessionConcurrency.get({ sessionId: root.id })).active, 0);
});

test('actual DSH runtime: cancelling a queued child frees it without sending a model request', { timeout: 20000 }, async t => {
  const fixture = await createFixture({ name: 'cancellation', policy: async (request, helpers) => {
    if (!request.parentId && request.count === 1) return [childCall('slow'), childCall('queued')];
    if (request.parentId) { await helpers.delay(180); return 'UNCANCELLED_RESULT'; }
    return 'PARENT_DONE';
  } });
  t.after(() => fixture.close());
  const root = await fixture.createRoot('root-cancellation');
  root.followup({ content: [{ type: 'text', text: 'Create two children.' }], source: { kind: 'user' } });
  await bounded((async () => {
    while (fixture.trace.filter(event => event.type === 'subagent/start').length < 2) await delay(2);
    while ((await fixture.ctx.sessionConcurrency.get({ sessionId: root.id })).queued < 1) await delay(2);
  })(), 'waiting for queued child');
  const childIds = fixture.trace.filter(event => event.type === 'subagent/start').map(event => event.id);
  const queuedId = childIds.find(id => !fixture.trace.some(event => event.type === 'model/start' && event.id === id));
  assert.ok(queuedId, 'One child must be waiting before provider dispatch.');
  fixture.ctx.subagents.interrupt(queuedId, { kind: 'ancestor', agent: root });
  await bounded(fixture.settle(root), 'queued child cancellation');
  assert.ok(!fixture.trace.some(event => event.type === 'model/start' && event.id === queuedId), 'Cancelled queue entry must never reach the adapter.');
  assert.equal(fixture.trace.filter(event => event.type === 'subagent/end').length, 2);
  const state = await fixture.ctx.sessionConcurrency.get({ sessionId: root.id });
  assert.deepEqual({ active: state.active, queued: state.queued, waiting: state.waiting }, { active: 0, queued: 0, waiting: 0 });
});

test('actual DSH runtime: persisted per-session choices survive plugin reload and default remains unmanaged', { timeout: 20000 }, async t => {
  const fixture = await createFixture({ name: 'persistence', policy: async () => 'DONE' });
  t.after(() => fixture.close());
  const one = await fixture.createRoot('root-one', 1);
  const three = await fixture.createRoot('root-three', 3);
  const unset = await fixture.createRoot('root-unset', null);
  await fixture.reloadPlugin();
  assert.equal((await fixture.ctx.sessionConcurrency.get({ sessionId: one.id })).limit, 1);
  assert.equal((await fixture.ctx.sessionConcurrency.get({ sessionId: three.id })).limit, 3);
  assert.equal((await fixture.ctx.sessionConcurrency.get({ sessionId: unset.id })).limit, null);
  assert.equal(fixture.ctx.sessionConcurrency.ownsSession(unset.id), false);
  await fixture.ctx.sessionConcurrency.set({ sessionId: one.id, limit: null });
  await fixture.reloadPlugin();
  assert.equal((await fixture.ctx.sessionConcurrency.get({ sessionId: one.id })).limit, null);
  assert.equal((await fixture.ctx.sessionConcurrency.get({ sessionId: three.id })).limit, 3);
  await assert.rejects(fixture.ctx.sessionConcurrency.set({ sessionId: three.id, limit: 0 }), /integer from 1 to 10/);
  await assert.rejects(fixture.ctx.sessionConcurrency.set({ sessionId: three.id, limit: 11 }), /integer from 1 to 10/);
});

test('actual DSH runtime: an unset session keeps the native background-parent behavior', { timeout: 20000 }, async t => {
  const fixture = await createFixture({ name: 'default', limit: null, policy: async (request, { delay }) => {
    if (!request.parentId && request.count === 1) return [childCall('native-child')];
    if (request.parentId) { await delay(90); return 'CHILD_DONE'; }
    return 'PARENT_CONTINUED';
  } });
  t.after(() => fixture.close());
  const root = await fixture.createRoot('root-default');
  root.followup({ content: [{ type: 'text', text: 'Run a background child.' }], source: { kind: 'user' } });
  await bounded(fixture.settle(root), 'native background behavior');
  const parentContinuation = fixture.trace.find(event => event.type === 'model/start' && event.id === root.id && event.count === 2);
  const childEnd = fixture.trace.find(event => event.type === 'subagent/end');
  assert.ok(parentContinuation && childEnd && parentContinuation.sequence < childEnd.sequence, 'A chat without a quota must retain DSH native parent continuation.');
});

for (const initialLimit of [null, 1]) {
  test(`actual DSH LLM: ${initialLimit === null ? 'default -> 1' : '1 -> default -> 1'} counts already running requests`, { timeout: 20000 }, async t => {
    const release = new Map();
    const fixture = await createFixture({ name: 'live-transition', limit: initialLimit, policy: request => new Promise(resolve => {
      release.set(request.count, () => resolve(`DONE:${request.count}`));
      request.options.signal.addEventListener('abort', () => resolve('CANCELLED'), { once: true });
      if (request.options.signal.aborted) resolve('CANCELLED');
    }) });
    t.after(() => fixture.close());
    const root = await fixture.createRoot(`root-transition-${initialLimit}`);
    const dispatch = async text => {
      for await (const _chunk of fixture.ctx.llm.stream({
        provider: 'offline-test', model: 'deterministic', sessionId: root.id,
        messages: [{ role: 'user', content: [{ type: 'text', text }] }], signal: new AbortController().signal,
      })) { /* consume the full real stream to retain its permit */ }
    };
    const waitForCalls = count => bounded((async () => { while ((fixture.calls.get(root.id) ?? 0) < count) await delay(2); })(), `waiting for ${count} real adapter calls`);
    const one = dispatch('one');
    await waitForCalls(1);
    if (initialLimit === 1) await fixture.ctx.sessionConcurrency.set({ sessionId: root.id, limit: null });
    const two = dispatch('two');
    await waitForCalls(2);
    assert.equal((await fixture.ctx.sessionConcurrency.get({ sessionId: root.id })).active, 2, 'Unrestricted requests must still be tracked.');
    await fixture.ctx.sessionConcurrency.set({ sessionId: root.id, limit: 1 });
    const three = dispatch('three');
    await delay(15);
    assert.equal(fixture.calls.get(root.id), 2, 'New request must wait behind both existing streams.');
    release.get(1)();
    await one;
    await delay(15);
    assert.equal(fixture.calls.get(root.id), 2, 'One remaining old request still occupies the only quota.');
    release.get(2)();
    await two;
    await waitForCalls(3);
    release.get(3)();
    await three;
    const state = await fixture.ctx.sessionConcurrency.get({ sessionId: root.id });
    assert.deepEqual({ active: state.active, queued: state.queued }, { active: 0, queued: 0 });
  });
}
