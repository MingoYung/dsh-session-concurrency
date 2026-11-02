/** Per-root-session inference scheduler. No DSH imports, credentials or transcript access. */
export class SessionConcurrencyScheduler {
  constructor(entries = [], ledger = { active: new Map(), listeners: new Set() }) {
    this.limits = new Map(entries);
    this.parents = new Map();
    this.runs = new Map();
    this.children = new Map();
    this.ledger = ledger;
    this.active = ledger.active;
    this.changed = () => this.pump();
    ledger.listeners.add(this.changed);
    this.queue = [];
    this.waiters = new Set();
    this.disposed = false;
  }

  registerSession(id, parentId = null) {
    if (typeof id !== 'string' || !id) return;
    if (parentId === id) throw new TypeError('A session cannot be its own parent.');
    this.parents.set(id, typeof parentId === 'string' && parentId ? parentId : null);
    this.pump();
  }

  rootOf(id) {
    const seen = new Set();
    let current = id;
    while (typeof current === 'string' && current && !seen.has(current)) {
      seen.add(current);
      const parent = this.parents.get(current);
      if (!parent) return current;
      current = parent;
    }
    return id;
  }

  limitOf(id) { return this.limits.get(this.rootOf(id)) ?? null; }
  ownsSession(id) { return this.limitOf(id) !== null; }

  setLimit(id, limit) {
    if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 10)) {
      throw new RangeError('Concurrency must be an integer from 1 to 10, or null.');
    }
    const root = this.rootOf(id);
    if (limit === null) this.limits.delete(root);
    else this.limits.set(root, limit);
    this.pump();
    return this.snapshot(id);
  }

  runStarted({ runId, id, parentId }) {
    if (!runId || !id || !parentId || this.runs.has(runId)) return;
    // Publish the parent link and activation atomically before pumping. A
    // request must not slip through between discovering a child and gating it.
    this.parents.set(id, parentId);
    this.runs.set(runId, { id, parentId, parked: false });
    let runs = this.children.get(parentId);
    if (!runs) this.children.set(parentId, runs = new Set());
    runs.add(runId);
    this.pump();
  }

  runEnded(runId) {
    const run = this.runs.get(runId);
    if (!run) return;
    this.runs.delete(runId);
    const runs = this.children.get(run.parentId);
    runs?.delete(runId);
    if (runs?.size === 0) this.children.delete(run.parentId);
    this.pump();
  }

  setParked(runId, parked) {
    const run = this.runs.get(runId);
    if (!run || run.parked === parked) return;
    run.parked = parked;
    this.pump();
  }

  firstChild(id) {
    for (const runId of this.children.get(id) ?? []) {
      const run = this.runs.get(runId);
      if (run && !run.parked) return run;
    }
  }

  blockReason(id) {
    if (this.limitOf(id) !== 1) return null;
    const seen = new Set();
    // Retain each branch's place until its activation settles, including tool
    // I/O between LLM calls. Descendants of that branch can still run, so nested
    // delegation never waits for a permit held by its own ancestor.
    for (let child = id, parent; (parent = this.parents.get(child)) && !seen.has(child); child = parent) {
      seen.add(child);
      const first = this.firstChild(parent);
      if (first && first.id !== child) return 'sibling';
    }
    return this.firstChild(id) ? 'children' : null;
  }

  blocked(id) { return this.blockReason(id) !== null; }

  waitForChildren(id, signal) {
    this.check(signal);
    if (!this.blocked(id)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { id, resolve, reject, signal };
      waiter.abort = () => {
        this.waiters.delete(waiter);
        reject(abortReason(signal));
      };
      this.waiters.add(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
      // The checks and insertion are synchronous, including already-aborted signals.
      if (signal?.aborted) waiter.abort();
    });
  }

  acquire(id, signal) {
    this.check(signal);
    // Track every session-bearing stream, including default/unlimited ones.
    // A later default -> limited transition must count already-running work.
    // A null quota is still admitted immediately by pump().
    return new Promise((resolve, reject) => {
      const item = { id, resolve, reject, signal };
      item.abort = () => {
        const index = this.queue.indexOf(item);
        if (index !== -1) this.queue.splice(index, 1);
        reject(abortReason(signal));
        this.pump();
      };
      this.queue.push(item);
      signal?.addEventListener('abort', item.abort, { once: true });
      if (signal?.aborted) item.abort();
      else this.pump();
    });
  }

  check(signal) {
    if (this.disposed) throw new Error('Session concurrency scheduler was unloaded.');
    if (signal?.aborted) throw abortReason(signal);
  }

  activeCount(root) {
    let count = 0;
    for (const id of this.active.values()) if (this.rootOf(id) === root) count++;
    return count;
  }

  pump() {
    if (this.disposed) return;
    for (const waiter of [...this.waiters]) {
      if (this.blocked(waiter.id)) continue;
      this.waiters.delete(waiter);
      waiter.signal?.removeEventListener('abort', waiter.abort);
      waiter.resolve();
    }
    // Scan past blocked ancestors: a strict FIFO head would deadlock limit 1
    // when its queued child is the only work that can unblock the ancestor.
    for (let index = 0; index < this.queue.length;) {
      const item = this.queue[index];
      if (item.signal?.aborted) { item.abort(); continue; }
      const root = this.rootOf(item.id);
      const limit = this.limitOf(item.id);
      if (this.blocked(item.id) || (limit !== null && this.activeCount(root) >= limit)) {
        index++;
        continue;
      }
      this.queue.splice(index, 1);
      item.signal?.removeEventListener('abort', item.abort);
      const token = {};
      this.active.set(token, item.id); // Reserve before resolving the promise.
      let released = false;
      item.resolve(() => {
        if (released) return;
        released = true;
        this.active.delete(token);
        for (const changed of this.ledger.listeners) changed();
      });
    }
  }

  snapshot(id) {
    const rootSessionId = this.rootOf(id);
    const waiting = new Set();
    const queued = new Set();
    for (const item of this.waiters) {
      if (this.rootOf(item.id) !== rootSessionId) continue;
      (this.blockReason(item.id) === 'children' ? waiting : queued).add(item.id);
    }
    for (const item of this.queue) {
      if (this.rootOf(item.id) !== rootSessionId) continue;
      if (this.blockReason(item.id) === 'children') waiting.add(item.id);
      else queued.add(item.id);
    }
    const runs = [...this.runs.values()].filter(run => this.rootOf(run.id) === rootSessionId);
    let serialAgentId = null;
    if (this.limitOf(id) === 1) {
      const seen = new Set();
      for (let child = this.firstChild(rootSessionId); child && !seen.has(child.id); child = this.firstChild(child.id)) {
        seen.add(child.id);
        serialAgentId = child.id;
      }
    }
    return {
      sessionId: id,
      rootSessionId,
      limit: this.limits.get(rootSessionId) ?? null,
      active: this.activeCount(rootSessionId),
      queued: queued.size,
      waiting: waiting.size,
      trackedChildren: runs.length,
      parkedChildren: runs.filter(run => run.parked).length,
      serialAgentId,
    };
  }

  cancelPending(id, reason = new DOMException('Agent disposed.', 'AbortError')) {
    for (const waiter of [...this.waiters]) {
      if (waiter.id !== id) continue;
      this.waiters.delete(waiter);
      waiter.signal?.removeEventListener('abort', waiter.abort);
      waiter.reject(reason);
    }
    for (const item of [...this.queue]) {
      if (item.id !== id) continue;
      this.queue.splice(this.queue.indexOf(item), 1);
      item.signal?.removeEventListener('abort', item.abort);
      item.reject(reason);
    }
    // Keep lifecycle state until subagent/end. DSH disposes a child BEFORE it
    // delivers the captured result and emits that terminal notification.
    this.pump();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.ledger.listeners.delete(this.changed);
    const reason = new DOMException('Session concurrency plugin unloaded.', 'AbortError');
    for (const item of [...this.waiters, ...this.queue]) {
      item.signal?.removeEventListener('abort', item.abort);
      item.reject(reason);
    }
    this.waiters.clear();
    this.queue.length = 0;
  }
}

function abortReason(signal) {
  return signal?.reason ?? new DOMException('Operation aborted.', 'AbortError');
}
