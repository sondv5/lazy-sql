import { build } from 'esbuild';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist');
const outFile = path.join(outDir, 'lazy-sql-engine.mjs');

// esbuild prefers a package's CommonJS "main" on the node platform; jsonc-parser's UMD build loads its own
// files with dynamic requires that cannot be bundled, so point it at the ESM build explicitly.
const jsoncParserEsm = path.join(path.dirname(createRequire(import.meta.url).resolve('jsonc-parser/package.json')), 'lib', 'esm', 'main.js');

await build({
  entryPoints: [path.join(root, 'src', 'index.js')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: {
    js: 'import { createRequire as __lazySqlCreateRequire } from "node:module";\nconst require = __lazySqlCreateRequire(import.meta.url);'
  },
  external: ['pg-native'],
  alias: { 'jsonc-parser': jsoncParserEsm },
  logLevel: 'info'
});

const size = fs.statSync(outFile).size;
console.log(`bundle: ${outFile} (${(size / 1024 / 1024).toFixed(2)} MB)`);

const appResources = path.resolve(root, '..', 'apps', 'desktop', 'src-tauri', 'resources');
fs.mkdirSync(appResources, { recursive: true });
fs.copyFileSync(outFile, path.join(appResources, 'lazy-sql-engine.mjs'));
console.log(`bundle: copied to ${path.join(appResources, 'lazy-sql-engine.mjs')}`);
