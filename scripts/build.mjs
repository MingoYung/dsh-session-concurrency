import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const result = await build({
  absWorkingDir: root,
  entryPoints: [path.join(root, 'client.jsx')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  external: ['react', 'react-dom'],
  target: ['chrome120'],
  minify: true,
  legalComments: 'inline',
});
const output = `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:function(require){\nvar module={exports:{}};var exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;\n}});\n`;
await mkdir(path.join(root, 'lib'), { recursive: true });
await writeFile(path.join(root, 'lib/client.js'), output, 'utf8');
console.log(`Built ${manifest.name}@${manifest.version}: ${Buffer.byteLength(output)} bytes`);
