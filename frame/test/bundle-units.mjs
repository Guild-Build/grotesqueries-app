// Bundle the viewer's TypeScript unit tests to .runtime/test/ for node --test. Node 24's own type stripping cannot run
// them: src/ imports its siblings as .js and uses constructor parameter properties, which strip-only mode refuses.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await esbuild.build({
  entryPoints: ['browser-state', 'tabs', 'preferences'].map(name => path.join(root, 'test', name + '.test.ts')),
  outdir: path.join(root, '.runtime/test'), outExtension: { '.js': '.mjs' },
  bundle: true, conditions: ['grotesqueries-source'], format: 'esm', platform: 'node', target: ['node24'], logLevel: 'warning',
});
