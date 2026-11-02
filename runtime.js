/**
 * DSH 0.2.1-rc.4 compatibility adapter. Lifecycle events remain the primary
 * contract. The guarded read-only manager snapshot and its exact activation
 * promises allow adoption after reload and recovery of a missed terminal event.
 * No model calls, interrupts, fabricated results or parent inbox writes.
 */
export class ActivationMonitor {
  constructor(ctx, scheduler, registerAgent) {
    this.ctx = ctx;
    this.scheduler = scheduler;
    this.registerAgent = registerAgent;
    this.tracked = new Map();
    this.sequence = 0;
    this.closed = false;
  }

  residents() {
    const resident = this.ctx.get('subagents')?.manager?.resident;
    return resident instanceof Map ? resident : null;
  }

  get mode() { return this.residents() ? 'native' : 'events'; }

  start(info, parentId) {
    const activation = this.residents()?.get(info.id);
    if (activation && this.track(activation, info.runId)) return;
    this.scheduler.runStarted({ ...info, parentId });
  }

  track(activation, runId) {
    if (this.closed) return false;
    if (this.tracked.has(activation)) return true;
    const { childId: id, parent, result } = activation;
    if (typeof id !== 'string' || typeof parent?.id !== 'string'
      || typeof result?.promise?.then !== 'function') return false;
    this.registerAgent(parent);
    this.registerAgent(activation.handle?.agent);
    // A fallback lifecycle registration may precede the manager becoming
    // available. Adopt that entry rather than double-count the same epoch.
    runId ??= [...this.scheduler.runs].find(([, run]) => run.id === id)?.[0]
      ?? `adopted:${++this.sequence}:${id}`;
    const record = { runId, activation };
    this.tracked.set(activation, record);
    this.scheduler.runStarted({ runId, id, parentId: parent.id });
    const finish = () => {
      if (this.closed) return;
      this.scheduler.runEnded(record.runId);
      this.tracked.delete(activation);
    };
    // This promise settles AFTER native result delivery and handle disposal.
    // Never treat an idle/missing Agent as a successful completed task.
    result.promise.then(finish, finish);
    return true;
  }

  reconcile() {
    if (this.closed) return;
    for (const activation of this.residents()?.values() ?? []) this.track(activation);
    for (const { runId, activation } of this.tracked.values()) {
      const agent = activation.handle?.agent;
      const inbox = agent?.inbox;
      // An interrupted continuable child can retain an explicitly parked inbox.
      // It needs a later waking message; do not restart it or wait forever for
      // it. A normal idle child flushing its final result is NOT parked.
      const parked = activation.kind === 'local' && activation.announced === true
        && activation.closing === undefined && activation.failureAt === undefined
        && agent?.status === 'idle' && activation.ownedChildren?.size === 0
        && ((inbox?.nextTurn?.length ?? 0) + (inbox?.nextStep?.length ?? 0) > 0);
      this.scheduler.setParked(runId, parked);
    }
  }

  dispose() { this.closed = true; this.tracked.clear(); }
}

/** Retain still-running streams across a plugin reload in this exact Host. */
export function streamLedger(ctx) {
  const key = Symbol.for('@local/session-concurrency/host-stream-ledgers/v1');
  const ledgers = globalThis[key] ??= new WeakMap();
  let ledger = ledgers.get(ctx.root);
  if (!ledger) ledgers.set(ctx.root, ledger = { active: new Map(), listeners: new Set() });
  return ledger;
}

export function concurrencyContext(scheduler, id) {
  const state = scheduler.snapshot(id);
  if (state.limit === null) return '';
  const lines = [
    '[session-concurrency / 会话并发运行规则]',
    `本根会话和全部子孙 Agent 共用 ${state.limit} 条模型推理通道。此值是本会话的实际调度限制。`,
  ];
  if (state.limit === 1) lines.push(
    '当前是单通道串行模式。需要委派时，一次派发一个独立子任务，收到结果后再派发下一个；不要把待办清单一次展开为大量并行子 Agent。',
    '派发成功后，宿主会在程序层让父 Agent 等待并释放推理通道，按分支顺序执行子任务（含嵌套子任务）。不要用 list_agents、重复查询、sleep 或空转推理轮询进度。',
    '子任务完成、失败或取消后的结果由 DSH 原生机制交回；工作流内部的 caller 审核结果仍交给原调用者。后台状态检查不调用模型，无需临时增加通道。',
    '只把实际派发成功的任务视为已启动。派发失败或没有子任务时，应处理真实错误、修正参数或说明阻塞原因，不要声称仍在等待不存在的子 Agent。',
    '调度规则不替代业务规则：保留 ClearAI 等工作流要求的独立审核和产物校验；不能用主 Agent 自评冒充审核成功。',
  );
  if (state.parkedChildren > 0) lines.push(`有 ${state.parkedChildren} 个子任务保留了已暂停的待处理输入，插件没有自动重启它们；不要把暂停视为完成。`);
  return lines.join('\n');
}

/** Serialize native delegation calls before they consume resident child slots. */
export class DelegationGate {
  constructor() { this.tails = new Map(); this.pending = new Set(); }

  async run(id, signal, task) {
    const previous = this.tails.get(id) ?? Promise.resolve();
    let unlock;
    const tail = new Promise(resolve => { unlock = resolve; });
    this.tails.set(id, tail);
    const controller = new AbortController();
    this.pending.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let abort;
    let entered = false;
    try {
      combined.throwIfAborted();
      await Promise.race([previous, new Promise((_, reject) => {
        abort = () => reject(combined.reason);
        combined.addEventListener('abort', abort, { once: true });
        if (combined.aborted) abort();
      })]);
      entered = true;
      combined.throwIfAborted();
      return await task(combined);
    } finally {
      combined.removeEventListener('abort', abort);
      this.pending.delete(controller);
      const release = () => {
        unlock();
        if (this.tails.get(id) === tail) this.tails.delete(id);
      };
      // Cancelling a queued call must not let its successor overtake the call
      // still holding the dispatch turn.
      if (entered) release();
      else previous.then(release);
    }
  }

  dispose() {
    for (const controller of this.pending) controller.abort(new DOMException('Concurrency plugin unloaded.', 'AbortError'));
  }
}
