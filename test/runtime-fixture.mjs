import { mkdtemp, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const directory = dirname(fileURLToPath(import.meta.url));
const homes = resolve(directory, 'homes');
// Lifecycle-only runs also need the parent of their mkdtemp prefix. Creating it
// at fixture import makes test files independent in a fresh checkout.
await mkdir(homes, { recursive: true });
// A normal checkout uses the exact devDependencies from package-lock.json.
// An explicit runtime override permits compatibility probes against an extracted
// DSH distribution; no machine-specific directory is assumed by default.
const runtime = process.env.DSH_TEST_RUNTIME
  ? resolve(process.env.DSH_TEST_RUNTIME, 'node_modules/@deepseek-ai')
  : null;
const moduleOf = name => runtime
  ? import(pathToFileURL(join(runtime, name, 'lib/index.js')).href)
  : import(`@deepseek-ai/${name}`);
const [cordis, llm, session, projection, prompt, tools, agents, loop, subagents, spawn, subagentTool,
  filesystem, workingDirectory, persistence, query, typert] = await Promise.all([
  'cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools',
  'dsh-agent', 'dsh-agent-loop', 'dsh-subagent', 'dsh-subagent-spawn-in-process', 'dsh-tool-subagent',
  'dsh-fs-local', 'dsh-working-directory', 'dsh-session-persistence-jsonl', 'dsh-session-query',
  'dsh-typert-registry',
].map(moduleOf));

export function texts(messages) {
  return messages.flatMap(message => message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
}

export async function createFixture({ policy, name = 'case', limit = 1, installPlugin = true, maxActiveSubagents = 10 } = {}) {
  const home = await mkdtemp(join(homes, `${name}-`));
  const ctx = new cordis.Context();
  const handles = [];
  const trace = [];
  const calls = new Map();
  const active = new Map();
  const peaks = new Map();
  let maximum = 0;
  let sequence = 0;
  const record = (type, fields = {}) => { const event = { sequence: ++sequence, type, ...fields }; trace.push(event); return event; };

  class FakeAdapter extends llm.LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, contextWindow: 100000, maxTokens: 4096 };
    }
    async *stream(options) {
      const id = options.sessionId;
      const agent = ctx.agents.get(id);
      const parentId = agent?.session.header.parentSession;
      const count = (calls.get(id) ?? 0) + 1;
      calls.set(id, count);
      const request = { id, parentId, count, text: texts(options.messages), options, agent };
      const token = Symbol(id);
      active.set(token, id);
      maximum = Math.max(maximum, active.size);
      let root = agent;
      while (root?.session.header.parentSession) root = ctx.agents.get(root.session.header.parentSession);
      const rootId = root?.id ?? id;
      const treeActive = [...active.values()].filter(other => {
        let a = ctx.agents.get(other);
        while (a?.session.header.parentSession) a = ctx.agents.get(a.session.header.parentSession);
        return (a?.id ?? other) === rootId;
      }).length;
      peaks.set(rootId, Math.max(peaks.get(rootId) ?? 0, treeActive));
      record('model/start', { id, parentId, rootId, count, text: request.text, active: active.size });
      try {
        const result = await policy(request, { ctx, record, delay: ms => delay(ms, undefined, { signal: options.signal }) });
        options.signal?.throwIfAborted();
        const blocks = Array.isArray(result) ? result : [{ type: 'text', text: result ?? `answer:${id}` }];
        for (const [index, block] of blocks.entries()) {
          yield { type: 'block-start', index, blockType: block.type };
          yield { type: 'block-end', index, block };
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
      } finally {
        active.delete(token);
        record('model/end', { id, parentId, rootId, count });
      }
    }
  }

  await ctx.plugin(typert.default);
  await ctx.plugin(session.default);
  await ctx.plugin(projection.default);
  await ctx.plugin(prompt.default, { includeHarnessIdentity: false, includeRuntimeContext: false });
  await ctx.plugin(tools.default, { mode: 'native' });
  await ctx.plugin(agents.default);
  await ctx.plugin(llm.default);
  await ctx.plugin(filesystem.default, { cwd: home });
  await ctx.plugin(workingDirectory.default, { defaultDirectory: home });
  await ctx.plugin(persistence, { root: join(home, 'sessions'), compression: 'none' });
  await ctx.plugin(query.default);
  await ctx.plugin(loop.default, { agents: [], maxParallelToolCalls: 10 });
  await ctx.plugin(subagents.default, { maxDepth: 5, maxActiveSubagents });
  await ctx.plugin(spawn, { providerName: 'spawn' });
  await ctx.plugin(subagentTool, { provider: 'spawn', maxDepth: 5 });
  await ctx.plugin({ name: 'test-offline-adapter', inject: ['llm'], apply(c) { c.llm.registerAdapter(['offline-test'], new FakeAdapter()); } });

  ctx.on('subagent/start', info => record('subagent/start', { id: info.id, runId: info.runId }), { global: true });
  ctx.on('subagent/end', info => record('subagent/end', { id: info.id, runId: info.runId, stopReason: info.stopReason }), { global: true });

  let pluginFiber;
  async function installConcurrencyPlugin() {
    const plugin = await import('../index.js');
    pluginFiber = await ctx.plugin(plugin, { storageFile: join(home, 'limits.json') });
  }
  if (installPlugin) await installConcurrencyPlugin();

  async function createRoot(id, ownLimit = limit) {
    const handle = await ctx.agents.create({ sessionId: id, agentOptions: { provider: 'offline-test', model: 'deterministic' }, meta: { cwd: home } });
    handles.push(handle);
    if (installPlugin && ownLimit !== undefined) await ctx.sessionConcurrency.set({ sessionId: id, limit: ownLimit });
    return handle.agent;
  }

  async function settle(agent) {
    for (let attempt = 0; attempt < 30; attempt++) {
      await agent.whenIdle();
      const before = agent.session.seq;
      const children = await ctx.subagents.waitForChildren(agent);
      await agent.whenIdle();
      if (!children && before === agent.session.seq) return;
    }
    throw new Error('Root failed to become stable after 30 drain passes.');
  }

  async function close() {
    for (const agent of ctx.agents.roots()) agent.cancel({ kind: 'user' });
    for (const handle of handles.reverse()) await handle.dispose();
    await pluginFiber?.dispose();
    await ctx.fiber.dispose();
  }

  return { ctx, home, trace, calls, peaks, active, maximum: () => maximum, createRoot, settle, close, record, installConcurrencyPlugin,
    async reloadPlugin() {
      if (!pluginFiber) throw new Error('Fixture was not created with the plugin.');
      await pluginFiber.dispose();
      const plugin = await import('../index.js');
      pluginFiber = await ctx.plugin(plugin, { storageFile: join(home, 'limits.json') });
    },
  };
}

export const childCall = (label, prompt = label) => ({
  type: 'tool-call', id: `call-${label}`, name: 'subagent',
  arguments: JSON.stringify({ description: label, prompt }),
});

export async function bounded(promise, label, milliseconds = 10000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds); })]);
  } finally { clearTimeout(timer); }
}
