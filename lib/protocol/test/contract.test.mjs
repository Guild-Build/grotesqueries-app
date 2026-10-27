// Contract tests that need only this package and Node 24: run `node --test` in lib/protocol.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { decodeBootstrap, decodeClientMessage, decodePluginManifest, decodeServerMessage, DEFAULT_LIMITS, importViolations,
  PROTOCOL_VERSION } from '../src/index.ts';

const hostInstanceId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
// Level 1 (P-02): one job and the folder it writes, served as pages. Shape only; slice 3 owns the real manifest.
const hansard = {
  name: 'hansard', contract: 3, profiles: [],
  commands: [{ id: 'hansard-conversations', label: 'Regenerate conversations', executable: 'python',
    args: ['-m', 'hansard', 'conversations', '--out', '{app}/.runtime/hansard/conversations'],
    projectDirectory: '{app}/.runtime/hansard', environment: { PYTHONPATH: 'X:/hansard/src' } }],
  folders: [{ id: 'conversations', path: '{app}/.runtime/hansard/conversations' }],
  pages: [{ label: 'Conversations', path: 'conversations/index.html' }],
};
const shell = { id: 'plugin-shell', label: 'Plugin shell', executable: 'bash.exe', args: ['--login'], projectDirectory: '{plugin}' };

test('wire protocol 4 retains plugin contract 3 manifests unchanged', () => {
  assert.equal(PROTOCOL_VERSION, 4);
  assert.deepEqual(decodePluginManifest(hansard), hansard);
  const panel = { ...hansard, name: 'workshop', profiles: [shell], panel: { label: 'Workshop', path: 'conversations/panel.html' } };
  assert.deepEqual(decodePluginManifest(panel), panel);
  assert.deepEqual(decodePluginManifest({ name: 'bare', contract: 3, profiles: [shell], commands: [], folders: [], pages: [] }).profiles, [shell]);
});

test('P-01: the manifest schema requires each documented field and rejects any other, at every level', () => {
  const panel = { label: 'Panel', path: 'conversations/panel.html' };
  const full = { ...hansard, profiles: [{ ...shell, environment: { MODE: 'x' } }], panel };
  assert.deepEqual(decodePluginManifest(full), full);
  const without = (value, key) => { const { [key]: _dropped, ...rest } = value; return rest; };
  // [level, required fields, optional fields, place one changed object into the full manifest]
  const levels = [
    ['manifest', ['name', 'contract', 'profiles', 'commands', 'folders', 'pages'], ['panel'], item => item, full],
    ['profile', ['id', 'label', 'executable', 'args', 'projectDirectory'], ['environment'], item => ({ ...full, profiles: [item] }), full.profiles[0]],
    ['command', ['id', 'label', 'executable', 'args', 'projectDirectory'], ['environment'], item => ({ ...full, commands: [item] }), full.commands[0]],
    ['folder', ['id', 'path'], [], item => ({ ...full, folders: [item] }), full.folders[0]],
    ['page', ['label', 'path'], [], item => ({ ...full, pages: [item] }), full.pages[0]],
    ['panel', ['label', 'path'], [], item => ({ ...full, panel: item }), panel],
  ];
  for (const [level, required, optional, place, item] of levels) {
    for (const key of required) assert.throws(() => decodePluginManifest(place(without(item, key))), /INVALID_MESSAGE/, `${level} without ${key}`);
    for (const key of optional) assert.doesNotThrow(() => decodePluginManifest(place(without(item, key))), `${level} without ${key}`);
    assert.throws(() => decodePluginManifest(place({ ...item, unknown: true })), /INVALID_MESSAGE/, `${level} with an unknown field`);
  }
});

test('manifest decoding rejects unknown fields, other contract versions and malformed declarations', () => {
  const [command] = hansard.commands, [folder] = hansard.folders, { pages: _pages, ...pageless } = hansard;
  for (const invalid of [null, [], { ...hansard, shell: true }, { ...hansard, contract: 2 }, { ...hansard, contract: '3' },
    { ...hansard, name: 'Hansard' }, { ...hansard, name: '../hansard' }, pageless,
    { ...hansard, commands: [{ ...command, shell: 'cmd.exe' }] }, { ...hansard, commands: [{ ...command, args: 'conversations' }] },
    { ...hansard, commands: [{ ...command, args: ['a\0b'] }] }, { ...hansard, commands: [{ ...command, executable: '' }] },
    { ...hansard, commands: [{ ...command, environment: { 'NOT-A-NAME': 'x' } }] },
    { ...hansard, commands: [{ ...command, environment: { PYTHONPATH: 1 } }] }, { ...hansard, commands: [{ ...command, environment: null }] },
    { ...hansard, commands: [{ ...command, id: 'has space' }] }, { ...hansard, profiles: [{ ...command }] },
    { ...hansard, commands: [{ ...command, label: '   ' }] }, { ...hansard, profiles: [{ ...shell, label: ' \t ' }] },
    { ...hansard, commands: Array.from({ length: 65 }, (_, index) => ({ ...command, id: `job-${index}` })) },
    { ...hansard, folders: [{ ...folder, path: '' }] }, { ...hansard, folders: [folder, folder] },
    { ...hansard, folders: [{ ...folder, readOnly: true }] },
    { ...hansard, pages: [{ label: 'Elsewhere', path: 'undeclared/index.html' }] },
    { ...hansard, pages: [{ label: 'Up', path: 'conversations/../secret.html' }] },
    { ...hansard, pages: [{ label: 'Folder', path: 'conversations' }] },
    { ...hansard, pages: [{ label: 'Absolute', path: '/conversations/index.html' }] },
    { ...hansard, panel: [{ label: 'Two', path: 'conversations/a.html' }] }, { ...hansard, panel: null },
    // Requirement 1.4: folders, project directories and path-shaped arguments begin with {app} or {plugin}.
    { ...hansard, folders: [{ ...folder, path: 'X:/./worktrees/x' }] }, { ...hansard, commands: [{ ...command, projectDirectory: '.' }] },
    { ...hansard, commands: [{ ...command, args: ['--out', 'X:/hansard/out'] }] },
    // Grotesqueries 4: a page or panel label of only whitespace is refused like a profile label.
    { ...hansard, pages: [{ label: '   ', path: 'conversations/index.html' }] },
    { ...hansard, panel: { label: ' \t ', path: 'conversations/panel.html' } }]) {
    assert.throws(() => decodePluginManifest(invalid), /INVALID_MESSAGE/, JSON.stringify(invalid)?.slice(0, 160));
  }
});

test('bootstrap lists every startable profile with its kind and each loaded plugin with what it contributed', () => {
  const bootstrap = { protocol: 3, hostInstanceId, token: 'harmless-fixture-token-only', sessions: [], limits: DEFAULT_LIMITS,
    profiles: [{ id: 'git-bash', label: 'Git Bash', projectDirectory: 'X:\\project', kind: 'interactive' },
      { id: 'hansard-conversations', label: 'Regenerate conversations', projectDirectory: 'X:\\hansard', kind: 'job' }],
    plugins: [{ name: 'hansard', contract: 3, panel: null, pages: hansard.pages, profiles: [], commands: ['hansard-conversations'] }] };
  assert.deepEqual(decodeBootstrap(bootstrap), bootstrap);
  const [plugin] = bootstrap.plugins, { plugins: _plugins, ...version2 } = bootstrap;
  for (const invalid of [version2, { ...bootstrap, profiles: [{ ...bootstrap.profiles[0], kind: 'agent' }] },
    { ...bootstrap, profiles: [{ id: 'git-bash', label: 'Git Bash', projectDirectory: 'X:\\project' }] },
    { ...bootstrap, plugins: [{ ...plugin, folders: [] }] }, { ...bootstrap, plugins: [{ ...plugin, panel: undefined }] },
    { ...bootstrap, plugins: [{ ...plugin, commands: ['bad id'] }] }, { ...bootstrap, plugins: [{ ...plugin, pages: [{ label: 'x', path: '../x' }] }] },
    { ...bootstrap, plugins: [{ ...plugin, pages: [{ label: ' ', path: 'conversations/index.html' }] }] },
    { ...bootstrap, plugins: [{ ...plugin, panel: { label: '\t', path: 'conversations/panel.html' } }] }]) {
    assert.throws(() => decodeBootstrap(invalid), /INVALID_MESSAGE/);
  }
});

test('a job reuses the session messages: deliberate start, the shared output stream and an exit summary', () => {
  const start = { type: 'start', requestId: 1, profileId: 'hansard-conversations', cols: 120, rows: 40 };
  assert.deepEqual(decodeClientMessage(start), start);
  assert.throws(() => decodeClientMessage({ ...start, args: ['--out', 'C:\\'] }), /INVALID_MESSAGE/);
  const output = { type: 'output', sessionId, sequence: 0, data: 'wrote 12 conversations\r\n' };
  assert.deepEqual(decodeServerMessage(output), output);
  const summary = { id: sessionId, label: 'Regenerate conversations', projectDirectory: 'X:\\hansard', profileId: 'hansard-conversations',
    createdAt: '2026-10-10T11:00:00.000Z', processState: 'exited', attachedViews: 1, controllerViewId: null, cols: 120, rows: 40,
    exitCode: 0, agentState: 'unknown', providerConversationId: null };
  for (const session of [summary, { ...summary, exitCode: null, failureCode: 'JOB_TIMEOUT' }, { ...summary, exitCode: 1, failureCode: 'JOB_OUTPUT_LIMIT' }]) {
    assert.deepEqual(decodeServerMessage({ type: 'session', session }), { type: 'session', session });
  }
});

test('A-05: plugin files may import only the contract and files inside their own folder', () => {
  const clean = {
    'ui/panel.html': '<script type="module" src="./panel.js"></script><p>Quoted from "Hansard"</p>',
    'ui/panel.js': "import { decodeServerMessage } from '@grotesqueries/protocol';\nimport { draw } from './draw.js';\nconst list = Array.from('ab');\nexport { draw };",
    'ui/draw.js': "export const draw = () => import('../shared/format.js');",
    'manifest.json': '{"name":"x"}',
  };
  for (const [file, source] of Object.entries(clean)) assert.deepEqual(importViolations(file, source), [], file);
  assert.deepEqual(importViolations('ui/panel.js', "import { Client } from '../../../app/javascript/client.js';"), ['../../../app/javascript/client.js']);
  assert.deepEqual(importViolations('ui/panel.ts', "export { SessionManager } from '@grotesqueries/host';"), ['@grotesqueries/host']);
  assert.deepEqual(importViolations('ui/panel.mjs', "const pty = require('node-pty'); await import('/app.js');"), ['node-pty', '/app.js']);
  assert.deepEqual(importViolations('ui/panel.html', '<script src=/app.js></script><script type="module">import "X:/grotesqueries/app/models/sessions.js";</script>'),
    ['/app.js', 'X:/grotesqueries/app/models/sessions.js']);
  assert.deepEqual(importViolations('panel.js', "import '..\\\\core.js';"), ['..\\\\core.js']);
  // Slice 1 F2's lexical holes, each the reviewer's probe.
  assert.deepEqual(importViolations('ui/p.html', '<script data-src="./ok.js" src="/app.js"></script>'), ['/app.js']);
  assert.deepEqual(importViolations('ui/p.html', '<script type="importmap">{"imports":{"@grotesqueries/protocol":"/app.js"}}</script>'),
    ['<script type="importmap">']);
  assert.deepEqual(importViolations('ui/p.js', "new Worker('/app.js', { type: 'module' }); new SharedWorker(\"/s.js\"); importScripts('/i.js');"),
    ['/app.js', '/s.js', '/i.js']);
  assert.deepEqual(importViolations('ui/p.vue', "<script setup>import { Client } from '../../../app/javascript/client.js';</script>"),
    ['../../../app/javascript/client.js']);
  assert.deepEqual(importViolations('ui/p.svelte', "<script>import './ok.js';</script>"), []);
});

test('C-01: the contract source imports only its own files', () => {
  const sources = fs.readdirSync(new URL('../src/', import.meta.url)).filter(file => file.endsWith('.ts'));
  assert.ok(sources.includes('index.ts') && sources.includes('validation.ts'));
  for (const file of sources) {
    assert.deepEqual(importViolations(`src/${file}`, fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')), [], file);
  }
});
