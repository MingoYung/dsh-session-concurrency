import { readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { carrierKeyOf } from '@deepseek-ai/dsh-scope';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { SessionConcurrencyScheduler } from './scheduler.js';
import { TYPERT_REMOTE } from './remote.js';
import { ActivationMonitor, concurrencyContext, DelegationGate, streamLedger } from './runtime.js';

export const name = 'session-concurrency';
export const inject = ['agents', 'llm', 'typert'];

const remoteInitializers = [];

/** Native Gateway service: ctx.remote.sessionConcurrency.get/set({sessionId,...}). */
export class SessionConcurrencyService extends TypertRemoteService {
  constructor(ctx, scheduler, persist, registerLive, hostCapacity, monitorMode = () => 'events') {
    super(ctx, 'sessionConcurrency');
    for (const initialize of remoteInitializers) initialize.call(this);
    this.scheduler = scheduler;
    this.persist = persist;
    this.registerLive = registerLive;
    this.hostCapacity = hostCapacity;
    this.monitorMode = monitorMode;
    // Cordis derives a receiver with Object.create(service) for each Remote
    // invocation. Mutate this shared object, never receiver-owned scalar fields.
    this.state = { updates: Promise.resolve(), closing: false, closePromise: undefined };
  }

  async get(request) {
    this.assertOpen();
    const sessionId = sessionIdOf(request);
    this.assertRootSession(sessionId);
    return this.snapshot(sessionId);
  }

  async set(request) {
    this.assertOpen();
    const sessionId = sessionIdOf(request);
    const limit = request?.limit;
    if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 10)) {
      throw new RangeError('Concurrency must be an integer from 1 to 10, or null.');
    }
    const state = this.state;
    const update = state.updates.catch(() => {}).then(async () => {
      this.assertRootSession(sessionId);
      const root = this.scheduler.rootOf(sessionId);
      const nextLimits = new Map(this.scheduler.limits);
      if (limit === null) nextLimits.delete(root);
      else nextLimits.set(root, limit);
      // Persist before admitting work under the new quota. Concurrent slider
      // updates are serialized; a failed disk write leaves effective state intact.
      await this.persist(nextLimits);
      this.scheduler.setLimit(sessionId, limit);
      return this.snapshot(sessionId);
    });
    state.updates = update;
    return update;
  }

  snapshot(sessionId) {
    return { ...this.scheduler.snapshot(sessionId), hostCapacity: this.hostCapacity(), monitorMode: this.monitorMode() };
  }

  assertOpen() {
    if (this.state.closing) {
      throw new RemoteError('gateway/service-unavailable', '会话并发设置正在关闭，请稍后重试', {});
    }
  }

  /** Reject new commands synchronously, then drain commands already accepted. */
  close() {
    const state = this.state;
    if (state.closePromise) return state.closePromise;
    state.closing = true;
    // Accepted updates only persist settings and change admission; they never
    // await child completion. Draining therefore cannot depend on child slots.
    state.closePromise = state.updates.then(() => {}, () => {});
    return state.closePromise;
  }

  assertRootSession(sessionId) {
    // The Remote resource fence authorizes only request.sessionId. Never expand
    // a child-scoped caller's get/set to its parent or siblings via rootOf().
    const liveParent = this.ctx.get('agents')?.get(sessionId)?.session?.header?.parentSession;
    if (typeof liveParent === 'string' || this.scheduler.rootOf(sessionId) !== sessionId) {
      throw new RemoteError('gateway/bad-request', '请在主会话设置并发额度，子会话继承主会话设置', {});
    }
    this.registerLive(sessionId);
  }

  /** Integration seam for older dispatch guards, without changing unmanaged chats. */
  ownsSession(sessionId) { return this.scheduler.ownsSession(sessionId); }
}

// Invoke the public decorator protocol directly so this plugin stays plain JS;
// these are the same prototype markers compiled @Remote methods install.
for (const method of ['get', 'set']) {
  Remote({ name: method, resources: { session: request => sessionIdOf(request) } })(
    SessionConcurrencyService.prototype[method],
    { kind: 'method', name: method, private: false, static: false,
      addInitializer(initialize) { remoteInitializers.push(initialize); } },
  );
}

export function apply(ctx, config = {}) {
  const storageFile = typeof config.storageFile === 'string'
    ? config.storageFile
    : dshHomePath('plugins', 'session-concurrency', 'limits.json');
  const scheduler = new SessionConcurrencyScheduler(loadLimits(storageFile, ctx.logger), streamLedger(ctx));
  let writes = Promise.resolve();
  const persist = limits => {
    // Capture this command's data before another Remote call can mutate it.
    const data = JSON.stringify({ version: 1, limits: Object.fromEntries(limits) }, null, 2) + '\n';
    const write = writes.catch(() => {}).then(async () => {
      await mkdir(dirname(storageFile), { recursive: true });
      const temporary = `${storageFile}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, data, { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, storageFile);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
    });
    writes = write;
    return write;
  };

  const registerAgent = agent => {
    if (!agent || typeof agent.id !== 'string') return;
    const seen = new Set();
    for (let current = agent; current && !seen.has(current.id);) {
      seen.add(current.id);
      const parentId = current.session?.header?.parentSession;
      scheduler.registerSession(current.id, typeof parentId === 'string' ? parentId : null);
      current = typeof parentId === 'string' ? ctx.agents.get(parentId) : undefined;
    }
  };
  const monitor = new ActivationMonitor(ctx, scheduler, registerAgent);
  const delegations = new DelegationGate();
  const registerLive = id => {
    registerAgent(ctx.agents.get(id));
    monitor.reconcile();
  };
  for (const agent of ctx.agents.list()) registerAgent(agent);
  const hostCapacity = () => {
    const value = ctx.get('subagents')?.config?.maxActiveSubagents?.get?.();
    return Number.isInteger(value) && value > 0 ? value : null;
  };
  // Host invocations belong to typert.local. remotes.register() only mounts
  // consumer definitions and would leave Gateway in unvalidated source mode.
  ctx.typert.register({
    package: TYPERT_REMOTE.package,
    face: 'host',
    schemas: [],
    invocations: TYPERT_REMOTE.descriptors,
    model: {
      services: [{
        key: 'sessionConcurrency', exportName: 'SessionConcurrencyService', tags: [], types: [],
        members: [
          { kind: 'method', name: 'get', signature: 'get(request: { sessionId: string }): Promise<SessionConcurrencySnapshot>' },
          { kind: 'method', name: 'set', signature: 'set(request: { sessionId: string, limit: number | null }): Promise<SessionConcurrencySnapshot>' },
        ],
      }],
      events: [], objects: [],
    },
  });
  const service = new SessionConcurrencyService(ctx, scheduler, persist, registerLive, hostCapacity, () => monitor.mode);

  ctx.inject(['systemPrompt'], promptCtx => {
    promptCtx.systemPrompt.context({
      name: 'session-concurrency:runtime', order: 121, required: true, interpolate: false,
      text: ({ agent, scope }) => {
        const current = agent ?? scope;
        if (typeof current?.id !== 'string') return '';
        registerLive(current.id);
        return concurrencyContext(scheduler, current.id);
      },
    });
  });

  ctx.on('agent/created', ({ agent }) => { registerAgent(agent); }, { global: true });
  ctx.on('subagent/start', function(info) {
    const child = ctx.agents.get(info.id);
    registerAgent(child);
    const carrierParent = carrierKeyOf(this);
    const parentId = child?.session?.header?.parentSession ?? carrierParent?.id;
    registerAgent(carrierParent);
    if (typeof parentId === 'string') monitor.start(info, parentId);
    else ctx.logger.warn('session-concurrency: a subagent start had no resolvable parent; it is not gated.');
  }, { global: true });
  ctx.on('subagent/end', info => { scheduler.runEnded(info.runId); }, { global: true });

  // Events and exact activation promises handle completion promptly. A bounded
  // host-only sweep adopts missed starts and refreshes parked/active state.
  // It neither calls the model nor guesses completion from elapsed time.
  let reconcileQueued = false;
  ctx.on('agent/status', () => {
    if (reconcileQueued) return;
    reconcileQueued = true;
    queueMicrotask(() => { reconcileQueued = false; monitor.reconcile(); });
  }, { global: true });
  monitor.reconcile();
  const timer = setInterval(() => monitor.reconcile(), 5000);
  timer.unref?.();

  ctx.on('tools/execute', async (exec, next) => {
    const parent = exec.agent;
    if (exec.name !== 'subagent' || !parent) return next();
    registerLive(parent.id);
    if (scheduler.limitOf(parent.id) !== 1) return next();
    return delegations.run(parent.id, exec.signal, async signal => {
      await scheduler.waitForChildren(parent.id, signal);
      signal.throwIfAborted();
      const result = await next();
      monitor.reconcile();
      await scheduler.waitForChildren(parent.id, signal);
      signal.throwIfAborted();
      return result;
    });
  }, { global: true });

  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const decision = await next();
    if (exec.agent) {
      registerAgent(exec.agent);
      monitor.reconcile();
      // Wait at the tool boundary, BEFORE the loop claims its next step. This
      // covers direct delegation and tools/workflows that delegate indirectly.
      // Child completion delivery remains free to enter the parent's inbox.
      await scheduler.waitForChildren(exec.agent.id, exec.signal);
      exec.signal?.throwIfAborted();
    }
    return decision;
  }, { global: true });

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    registerAgent(agent);
    monitor.reconcile();
    await scheduler.waitForChildren(agent.id, signal);
    signal.throwIfAborted();
    return next();
  }, { global: true });

  ctx.on('llm/stream', async function* (options, next) {
    const id = options.sessionId;
    if (typeof id !== 'string') { yield* next(); return; }
    registerLive(id);
    // Also gates auxiliary calls made before pre-step. No permit is held while
    // a parent is waiting, and tools/result delivery runs outside this stream.
    // Default sessions are tracked but not delayed, so enabling a quota later
    // accounts for streams already running before the setting changed.
    await scheduler.waitForChildren(id, options.signal);
    const release = await scheduler.acquire(id, options.signal);
    try {
      options.signal?.throwIfAborted();
      yield* next();
    } finally { release(); }
  }, { global: true });

  ctx.on('agent/disposed', ({ agent }) => {
    if (agent?.id) scheduler.cancelPending(agent.id);
  }, { global: true });
  ctx.effect(() => async () => {
    // A successor may read limits.json as soon as this fiber is disposed. Keep
    // the old scheduler valid until every accepted setter has committed, and
    // ensure no old-generation write can land after disposal has completed.
    await service.close();
    await writes.catch(() => {});
    clearInterval(timer);
    delegations.dispose();
    monitor.dispose();
    scheduler.dispose();
  }, 'session-concurrency: drain settings and clean pending requests');
}

function sessionIdOf(request) {
  const id = request?.sessionId;
  if (typeof id !== 'string' || !id || id.length > 256) throw new TypeError('A sessionId is required.');
  return id;
}

function loadLimits(path, logger) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.version !== 1 || !parsed.limits || typeof parsed.limits !== 'object' || Array.isArray(parsed.limits)) {
      throw new TypeError('Unsupported session-concurrency settings format.');
    }
    return Object.entries(parsed.limits).filter(([id, limit]) => id && id.length <= 256
      && Number.isInteger(limit) && limit >= 1 && limit <= 10);
  } catch (error) {
    if (error?.code !== 'ENOENT') logger.warn(`session-concurrency: settings could not be read: ${error.message}`);
    return [];
  }
}
