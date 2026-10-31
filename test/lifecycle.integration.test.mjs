import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { SessionConcurrencyService } from '../index.js';
import { SessionConcurrencyScheduler } from '../scheduler.js';
import { bounded, createFixture } from './runtime-fixture.mjs';

test('service shutdown drains accepted durable changes and refuses commands after closure', { timeout: 20000 }, async t => {
  const ctx = new Context();
  const scheduler = new SessionConcurrencyScheduler();
  const home = await mkdtemp(resolve('test/homes/lifecycle-'));
  const storage = join(home, 'limits.json');
  let allowDisk;
  const diskGate = new Promise(resolve => { allowDisk = resolve; });
  let firstWriteEntered;
  const entered = new Promise(resolve => { firstWriteEntered = resolve; });
  let writes = 0;
  let service;
  let closingFinished = false;
  const fiber = await ctx.plugin({ name: 'controlled-durable-concurrency-service', apply(c) {
    service = new SessionConcurrencyService(c, scheduler, async limits => {
      if (++writes === 1) { firstWriteEntered(); await diskGate; }
      await writeFile(storage, JSON.stringify({ version: 1, limits: Object.fromEntries(limits) }), 'utf8');
    }, () => {}, () => 10);
    c.effect(() => async () => { await service.close(); scheduler.dispose(); closingFinished = true; }, 'test durable shutdown barrier');
  } });
  t.after(async () => { allowDisk(); await fiber.dispose(); await ctx.fiber.dispose(); });
  const acceptedOne = ctx.sessionConcurrency.set({ sessionId: 'lifecycle-alpha', limit: 2 });
  await bounded(entered, 'first pending disk write');
  const acceptedTwo = ctx.sessionConcurrency.set({ sessionId: 'lifecycle-beta', limit: 6 });
  const dispose = fiber.dispose();
  await delay(10);
  assert.equal(closingFinished, false, 'Plugin disposal must await its accepted disk writes.');
  assert.equal(scheduler.disposed, false, 'Scheduler must remain available until accepted updates commit.');
  await assert.rejects(service.get({ sessionId: 'lifecycle-alpha' }), error => error.code === 'gateway/service-unavailable');
  await assert.rejects(service.set({ sessionId: 'lifecycle-alpha', limit: 9 }), error => error.code === 'gateway/service-unavailable');
  allowDisk();
  const [one, two] = await bounded(Promise.all([acceptedOne, acceptedTwo]), 'accepted durable updates');
  assert.equal(one.limit, 2);
  assert.equal(two.limit, 6);
  await bounded(dispose, 'plugin disposal after disk flush');
  assert.equal(closingFinished, true);
  assert.equal(scheduler.disposed, true);
  const durable = JSON.parse(await readFile(storage, 'utf8'));
  assert.deepEqual(durable.limits, { 'lifecycle-alpha': 2, 'lifecycle-beta': 6 });
  const reloaded = new SessionConcurrencyScheduler(Object.entries(durable.limits));
  assert.equal(reloaded.limitOf('lifecycle-alpha'), 2);
  assert.equal(reloaded.limitOf('lifecycle-beta'), 6);
});

test('actual Host plugin reload immediately after an accepted update retains its successful value', { timeout: 20000 }, async t => {
  const fixture = await createFixture({ name: 'actual-close', policy: async () => 'DONE' });
  t.after(() => fixture.close());
  const root = await fixture.createRoot('actual-close-root', null);
  const oldService = fixture.ctx.sessionConcurrency;
  const accepted = oldService.set({ sessionId: root.id, limit: 8 });
  const reload = fixture.reloadPlugin();
  const result = await bounded(accepted, 'accepted write during Host reload');
  assert.equal(result.limit, 8);
  await bounded(reload, 'actual Host reload');
  assert.equal((await fixture.ctx.sessionConcurrency.get({ sessionId: root.id })).limit, 8);
  assert.equal(JSON.parse(await readFile(join(fixture.home, 'limits.json'), 'utf8')).limits[root.id], 8);
  await assert.rejects(oldService.set({ sessionId: root.id, limit: 2 }), error => error.code === 'gateway/service-unavailable');
});
