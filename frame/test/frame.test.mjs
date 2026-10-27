// The frame builds to its four files, licenses.txt among them, and reaches the contract only by package name
// (requirement 4.1.1, 4.1.4). Each check carries the input it fails on.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { findPackageJSON } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { build, root } from '../build.mjs';

const files = folder => fs.readdirSync(folder, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile()).map(entry => path.relative(folder, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/')).sort();

/** Every line under folder that names lib/protocol inside a module specifier. */
function protocolSourceImports(folder) {
  const found = [];
  for (const file of files(folder)) {
    fs.readFileSync(path.join(folder, file), 'utf8').split('\n').forEach((line, index) => {
      if (/['"`][^'"`]*lib\/protocol/.test(line)) found.push(file + ':' + (index + 1));
    });
  }
  return found;
}

function scratch(name) {
  const folder = path.join(root, '.runtime', name + '-' + process.pid);
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

test('npm run build writes index.html, assets/app.js, assets/app.css and assets/licenses.txt to dist/, and nothing else', async () => {
  await build();
  assert.deepEqual(files(path.join(root, 'dist')), ['assets/app.css', 'assets/app.js', 'assets/licenses.txt', 'index.html']);
});

/** The package names with no "Package: <name>" line in a licences text. */
const missingSections = (text, names) => names.filter(name => !text.split('\n').includes('Package: ' + name));

test('J6-S2-F2, requirement 4.1.1: licenses.txt has a section for every package the bundle carries; control: a removed name is missed', async () => {
  // The expected set is found apart from build.mjs's: each dependency's real folder, where Node resolves it (a hoisted
  // package in the root's node_modules, a workspace link to its own folder), held against every bundled input, and no
  // input may fall outside the frame and those folders.
  const { metafile } = await build();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const folders = Object.keys(manifest.dependencies).map(name => [name, fs.realpathSync(path.dirname(findPackageJSON(name, import.meta.url))) + path.sep]);
  const inputs = Object.keys(metafile.inputs).map(input => path.resolve(root, input));
  const bundled = folders.filter(([, folder]) => inputs.some(input => input.startsWith(folder))).map(([name]) => name).sort();
  const own = path.join(root, 'src') + path.sep, styles = path.join(root, 'assets') + path.sep;
  assert.deepEqual(inputs.filter(input => !input.startsWith(own) && !input.startsWith(styles) && !folders.some(([, folder]) => input.startsWith(folder))), []);
  assert.deepEqual(bundled, ['@grotesqueries/protocol', '@xterm/addon-fit', '@xterm/addon-unicode11', '@xterm/addon-webgl', '@xterm/xterm']);
  const text = fs.readFileSync(path.join(root, 'dist/assets/licenses.txt'), 'utf8');
  assert.deepEqual(missingSections(text, bundled), []);
  for (const name of ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-webgl']) {
    const license = fs.readFileSync(path.join(path.dirname(findPackageJSON(name, import.meta.url)), 'LICENSE'), 'utf8').trim();
    assert.ok(text.includes(license), name + "'s LICENSE text");
  }
  assert.ok(text.includes('Package: @grotesqueries/protocol\nVersion: 0.1.1\nLicence: Apache-2.0'));
  assert.ok(text.includes(fs.readFileSync(path.resolve(root, '../LICENSE'), 'utf8').trim()));
  assert.deepEqual(missingSections(text.replace('Package: @grotesqueries/protocol\n', ''), bundled), ['@grotesqueries/protocol']);
});

test('src/ holds no import of lib/protocol; control: a planted line is found', () => {
  assert.deepEqual(protocolSourceImports(path.join(root, 'src')), []);
  const folder = scratch('planted');
  try {
    fs.cpSync(path.join(root, 'src'), folder, { recursive: true });
    fs.appendFileSync(path.join(folder, 'terminal/view.ts'), "import { installSnapshotState } from '../../../lib/protocol/src/terminal-state-adapter.js';\n");
    assert.equal(protocolSourceImports(folder).length, 1);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
