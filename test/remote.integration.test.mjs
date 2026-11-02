import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Context, Service } from '@deepseek-ai/cordis';
import * as hostConnection from '@deepseek-ai/dsh-client-connection';
import * as clientGateway from '@deepseek-ai/dsh-api-gateway/client';
import Gateway from '@deepseek-ai/dsh-api-gateway';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import Typert from '@deepseek-ai/dsh-typert-registry';
import TYPERT_REMOTE from '../remote.js';
import { createFixture } from './runtime-fixture.mjs';

async function remoteFixture({ policy = async () => 'DONE' } = {}) {
  const fixture = await createFixture({ name: 'remote', policy });
  const host = fixture.ctx;
  await host.plugin(RemoteAccess);
  await host.plugin({ name: 'test-native-host-connection', apply(c) {
    // No network listener or browser login is created. Actual Connection fetch
    // framing and actual Peer lifetimes remain under test.
    new hostConnection.HostConnectionService(c, ['localhost'], {});
  } });
  await host.plugin(Gateway);
  const peer = host.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' });
  const handler = host.connection.createSharedFetchHandler('/api');
  const wire = [];
  let currentPeer = peer;
  let rpcId = 0;
  const client = new Context();
  await client.plugin(Typert);
  await client.plugin({ name: 'test-fetch-remote-carrier', apply(c) {
    class FetchCarrier extends Service {
      constructor(context) {
        super(context, 'connection');
        this.interactions = 'none';
        this.isLoopback = true;
        this.rpc = {
          open() { throw new Error('This unary test does not open streams.'); },
          async call(channel, endpoint, payload, signal) {
            const body = JSON.stringify({ type: 'client-request', rpcId: `test-${++rpcId}`, method: endpoint, payload });
            const request = new Request(`http://localhost${channel}/${endpoint}`, {
              method: 'POST', headers: { 'content-type': 'application/json' }, body, signal,
            });
            const response = await handler.fetch(request, currentPeer);
            const envelope = await response.json();
            wire.push({ endpoint, body: JSON.parse(body), status: response.status, envelope });
            return envelope.result;
          },
        };
      }
    }
    new FetchCarrier(c);
  } });
  await client.plugin(clientGateway);
  const unmount = await client.remote.$mount(TYPERT_REMOTE);
  return {
    ...fixture, client, wire, handler,
    asPeer(value) { currentPeer = value; },
    createPeer(principal) { return host.connection.createPeer({ principal, interactions: 'none' }); },
    async close() { await unmount(); await client.fiber.dispose(); await peer.dispose(); await fixture.close(); },
  };
}

test('native Client Remote -> JSON Fetch -> Host Gateway round-trips the quota contract', { timeout: 20000 }, async t => {
  const fixture = await remoteFixture();
  t.after(() => fixture.close());
  const root = await fixture.createRoot('remote-session', null);
  const response = await fixture.client.remote.sessionConcurrency.set({ sessionId: root.id, limit: 4 });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.deepEqual(response.value, {
    sessionId: root.id, rootSessionId: root.id, limit: 4, active: 0, queued: 0, waiting: 0, hostCapacity: 10,
    trackedChildren: 0, parkedChildren: 0, serialAgentId: null, monitorMode: 'native',
  });
  const get = await fixture.client.remote.sessionConcurrency.get({ sessionId: root.id });
  assert.equal(get.ok, true);
  assert.equal(get.value.limit, 4);
  assert.deepEqual(fixture.wire[0].body.payload, { args: { request: { sessionId: root.id, limit: 4 } } });
  assert.equal(fixture.wire[0].status, 200);
  const reset = await fixture.client.remote.sessionConcurrency.set({ sessionId: root.id, limit: null });
  assert.equal(reset.ok, true);
  assert.equal(reset.value.limit, null);
});

test('native Gateway rejects malformed typed values before mutating session state', { timeout: 20000 }, async t => {
  const fixture = await remoteFixture();
  t.after(() => fixture.close());
  const root = await fixture.createRoot('remote-invalid', 2);
  for (const limit of [0, 11, 1.5, '1']) {
    const response = await fixture.client.remote.sessionConcurrency.set({ sessionId: root.id, limit });
    assert.equal(response.ok, false, `Invalid value ${String(limit)} should fail.`);
    assert.equal(response.error.code, 'gateway/input-invalid');
  }
  const missing = await fixture.client.remote.sessionConcurrency.set({ sessionId: root.id });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'gateway/input-invalid');
  assert.equal((await fixture.ctx.sessionConcurrency.get({ sessionId: root.id })).limit, 2);
});

test('native Gateway enforces session-resource access for non-owner Peers', { timeout: 20000 }, async t => {
  const fixture = await remoteFixture();
  t.after(() => fixture.close());
  const allowed = await fixture.createRoot('remote-allowed', 1);
  const other = await fixture.createRoot('remote-other', 3);
  const guest = fixture.createPeer({ kind: 'test-guest', id: 'reader' });
  const seen = [];
  fixture.ctx.remoteAccess.registerPolicy('test-guest', {
    bindings() { return [{
      role: { name: 'test-session-reader', resource: 'session', actions: ['sessionConcurrency/get'] },
      resource: { kind: 'session', id: allowed.id },
    }]; },
    explain(request) { seen.push(request); },
  });
  fixture.asPeer(guest);
  const read = await fixture.client.remote.sessionConcurrency.get({ sessionId: allowed.id });
  assert.equal(read.ok, true, JSON.stringify(read));
  const deniedRead = await fixture.client.remote.sessionConcurrency.get({ sessionId: other.id });
  assert.equal(deniedRead.ok, false);
  assert.equal(deniedRead.error.code, 'remote-access/denied');
  const deniedWrite = await fixture.client.remote.sessionConcurrency.set({ sessionId: allowed.id, limit: 8 });
  assert.equal(deniedWrite.ok, false);
  assert.equal(deniedWrite.error.code, 'remote-access/denied');
  assert.equal((await fixture.ctx.sessionConcurrency.get({ sessionId: allowed.id })).limit, 1);
  assert.ok(seen.some(request => request.resources?.some(resource => resource.kind === 'session' && resource.id === other.id)), 'Access policy must receive the requested Session resource, not global scope.');
  await guest.dispose();
  const disposed = await fixture.client.remote.sessionConcurrency.get({ sessionId: allowed.id });
  assert.equal(disposed.ok, false);
  assert.equal(disposed.error.code, 'gateway/peer-disposed');
});

test('native Remote rejects a child session address instead of changing its parent quota', { timeout: 20000 }, async t => {
  let releaseChild;
  const fixture = await remoteFixture({ policy: request => request.parentId ? new Promise(resolve => {
    releaseChild = () => resolve('CHILD_DONE');
    request.options.signal.addEventListener('abort', () => resolve('CANCELLED'), { once: true });
    if (request.options.signal.aborted) resolve('CANCELLED');
  }) : 'DONE' });
  t.after(async () => { releaseChild?.(); await fixture.close(); });
  const root = await fixture.createRoot('remote-root-policy', 2);
  const activation = await fixture.ctx.subagents.startActivation({
    provider: 'spawn', label: 'live-child', delivery: 'caller', signal: new AbortController().signal,
    request: { parent: root, cwd: fixture.home, prompt: [{ type: 'text', text: 'Remain live for the resource test.' }] },
  });
  assert.ok(fixture.ctx.agents.get(activation.childId), 'Child must be a live native Agent.');
  await assert.rejects(fixture.ctx.sessionConcurrency.get({ sessionId: activation.childId }));
  await assert.rejects(fixture.ctx.sessionConcurrency.set({ sessionId: activation.childId, limit: 9 }));
  const read = await fixture.client.remote.sessionConcurrency.get({ sessionId: activation.childId });
  assert.equal(read.ok, false);
  const write = await fixture.client.remote.sessionConcurrency.set({ sessionId: activation.childId, limit: 9 });
  assert.equal(write.ok, false);
  assert.equal((await fixture.ctx.sessionConcurrency.get({ sessionId: root.id })).limit, 2);
  while (!releaseChild) await new Promise(resolve => setTimeout(resolve, 2));
  releaseChild();
  await activation.result;
});

test('native Remote concurrent writes to separate sessions share one durable update sequence', { timeout: 20000 }, async t => {
  const fixture = await remoteFixture();
  let releaseDisk;
  t.after(async () => { releaseDisk?.(); await fixture.close(); });
  const alpha = await fixture.createRoot('remote-concurrent-alpha', null);
  const beta = await fixture.createRoot('remote-concurrent-beta', null);
  const service = fixture.ctx.sessionConcurrency;
  const originalPersist = service.persist;
  const diskGate = new Promise(resolve => { releaseDisk = resolve; });
  let firstWriteEntered;
  const entered = new Promise(resolve => { firstWriteEntered = resolve; });
  let writes = 0;
  service.persist = async limits => {
    if (++writes === 1) { firstWriteEntered(); await diskGate; }
    return originalPersist(limits);
  };
  const pending = Promise.all([
    fixture.client.remote.sessionConcurrency.set({ sessionId: alpha.id, limit: 2 }),
    fixture.client.remote.sessionConcurrency.set({ sessionId: beta.id, limit: 7 }),
  ]);
  await entered;
  await delay(10);
  assert.equal(writes, 1, 'Derived Gateway service receivers must share the same pending update tail.');
  releaseDisk();
  const values = await pending;
  assert.ok(values.every(value => value.ok), JSON.stringify(values));
  await fixture.reloadPlugin();
  const alphaState = await fixture.client.remote.sessionConcurrency.get({ sessionId: alpha.id });
  const betaState = await fixture.client.remote.sessionConcurrency.get({ sessionId: beta.id });
  assert.equal(alphaState.ok, true);
  assert.equal(betaState.ok, true);
  assert.equal(alphaState.value.limit, 2, 'Alpha policy must not disappear when Beta snapshots concurrent state.');
  assert.equal(betaState.value.limit, 7, 'Beta policy must survive reloading the actual Host plugin.');
});

test('native Remote accepted write finishes before Host reload and shares the root closing barrier', { timeout: 20000 }, async t => {
  const fixture = await remoteFixture();
  let releaseDisk;
  t.after(async () => { releaseDisk?.(); await fixture.close(); });
  const root = await fixture.createRoot('wire-close-root', null);
  const oldService = fixture.ctx.sessionConcurrency;
  const originalPersist = oldService.persist;
  const diskGate = new Promise(resolve => { releaseDisk = resolve; });
  let firstWriteEntered;
  const entered = new Promise(resolve => { firstWriteEntered = resolve; });
  oldService.persist = async limits => { firstWriteEntered(); await diskGate; return originalPersist(limits); };
  const accepted = fixture.client.remote.sessionConcurrency.set({ sessionId: root.id, limit: 5 });
  await entered;
  let reloaded = false;
  const reload = fixture.reloadPlugin().then(() => { reloaded = true; });
  await delay(10);
  assert.equal(reloaded, false, 'Actual Host unload must wait for a wire invocation accepted by a derived service receiver.');
  await assert.rejects(oldService.get({ sessionId: root.id }), error => error.code === 'gateway/service-unavailable');
  await assert.rejects(oldService.set({ sessionId: root.id, limit: 9 }), error => error.code === 'gateway/service-unavailable');
  releaseDisk();
  const success = await accepted;
  assert.equal(success.ok, true, JSON.stringify(success));
  assert.equal(success.value.limit, 5);
  await reload;
  const state = await fixture.client.remote.sessionConcurrency.get({ sessionId: root.id });
  assert.equal(state.ok, true);
  assert.equal(state.value.limit, 5, 'The reloaded instance must read the last successful old wire update.');
});
