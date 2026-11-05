import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Test-only: replace the entire declared DSH dependency set together. Never
// override just fixture imports while Remote and plugin imports use another Host.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const versions = { '0.2.1-rc.4': '4.0.5', '0.2.2-rc.1': '4.1.0' };
const runtime = process.argv[2];
assert.ok(Object.hasOwn(versions, runtime), 'Select an explicitly tested DSH runtime.');
const packages = Object.keys(manifest.devDependencies).filter(name =>
  name.startsWith('@deepseek-ai/dsh-') &&
  (runtime !== '0.2.1-rc.4' || name !== '@deepseek-ai/dsh-tool-executor-native'));
const expected = runtime === '0.2.1-rc.4'
  // Include the legacy Host's transitive peers too (for example dsh-sandbox),
  // which --legacy-peer-deps intentionally does not install automatically.
  ? new Map(Object.entries(JSON.parse(await readFile(resolve(root, 'test/hosts/0.2.1-rc.4.json'), 'utf8'))))
  : new Map(packages.map(name => [name, runtime]));
expected.set('@deepseek-ai/cordis', versions[runtime]);

const require = createRequire(resolve(root, 'package.json'));
async function resolvedVersion(name) {
  try { return JSON.parse(await readFile(require.resolve(`${name}/package.json`), 'utf8')).version; }
  catch (error) { if (error.code === 'MODULE_NOT_FOUND') return null; throw error; }
}
const resolvedVersions = await Promise.all([...expected.keys()].map(resolvedVersion));
if ([...expected.values()].some((version, index) => resolvedVersions[index] !== version)) {
  // The newer executor remains installed but is not imported by the legacy
  // fixture. Its newer peer requirement must not force a second active Host.
  const args = ['install', '--no-save', '--package-lock=false', '--legacy-peer-deps',
    '--ignore-scripts', '--no-audit', '--no-fund',
    ...[...expected].map(([name, version]) => `${name}@${version}`)];
  // Invoke npm's JavaScript entry point on Windows without a shell or .cmd
  // quoting. setup-node and the standard Node installer ship it beside Node.
  const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const result = process.platform === 'win32'
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd: root, stdio: 'inherit' })
    : spawnSync('npm', args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Installing the selected test runtime failed.');
}

for (const [name, version] of expected) {
  const actual = await resolvedVersion(name);
  assert.equal(actual, version, `${name} resolved to a different runtime.`);
}
console.log(`Verified ${expected.size} Host packages: DSH ${runtime}, Cordis ${versions[runtime]}.`);
