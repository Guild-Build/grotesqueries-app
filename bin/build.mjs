// Build Grotesqueries' host bundle and its own public files; the page is the frame's (requirement 4.2.3).
// Source provenance: docs/reuse.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { assertSourceNode, distributionMetadata } from './licenses.mjs';
import { buildNative } from './native-build.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The frame's built folder: AUTOMATA_FRAME when set, else config/grotesqueries.json's `frame`, else frame/dist in the repository. */
export function frameFolder() {
  const configured = JSON.parse(fs.readFileSync(path.join(root, 'config/grotesqueries.json'), 'utf8')).frame;
  const frame = process.env.AUTOMATA_FRAME || (configured && path.resolve(root, 'config', configured)) || path.join(root, 'frame', 'dist');
  return path.resolve(frame);
}

export async function build(watch = false) {
  assertSourceNode(root);
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  distributionMetadata(root);
  buildNative(root);
  const options = [
    {
      entryPoints: [path.join(root, 'config/boot.ts')],
      outfile: path.join(root, 'dist', 'host', 'server.js'),
      bundle: true, conditions: ['grotesqueries-source'], format: 'esm', platform: 'node', target: ['node24'],
      external: ['node-pty', 'ws'], logLevel: 'info',
    },
    {
      entryPoints: [path.join(root, 'config/setup-posix.ts')],
      outfile: path.join(root, 'dist', 'host', 'setup.js'),
      bundle: true, conditions: ['grotesqueries-source'], format: 'esm', platform: 'node', target: ['node24'],
      logLevel: 'info',
    },
  ];
  if (!watch) { await Promise.all(options.map((option) => esbuild.build(option))); return []; }
  const contexts = await Promise.all(options.map((option) => esbuild.context(option)));
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.watch()));
  return contexts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build();
}
