import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { assertManagedPath, managedDirectory } from '../helpers/runtime.js';

export interface NativeManifest {
  buildId: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}
const hash = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');

export function extractNativePayload(root: string, manifest: NativeManifest,
  read: (name: string) => Uint8Array): string {
  if (!/^[a-f0-9]{16,64}$/.test(manifest.buildId) || manifest.files.length > 128) throw new Error('NATIVE_PAYLOAD_INVALID');
  const directory = managedDirectory(root, path.join(root, '.runtime/native', manifest.buildId));
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..') ||
      path.win32.isAbsolute(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 16 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(file.sha256) || seen.has(file.path.toLowerCase())) throw new Error('NATIVE_PAYLOAD_INVALID');
    seen.add(file.path.toLowerCase());
    const target = assertManagedPath(root, path.join(directory, file.path));
    if (fs.existsSync(target) && fs.statSync(target).size === file.bytes && hash(fs.readFileSync(target)) === file.sha256) continue;
    const bytes = read(file.path);
    if (bytes.byteLength !== file.bytes || hash(bytes) !== file.sha256) throw new Error('NATIVE_PAYLOAD_INTEGRITY_FAILED');
    managedDirectory(root, path.dirname(target));
    const temporary = assertManagedPath(root, `${target}.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, bytes, { flag: 'wx' });
      assertManagedPath(root, target);
      fs.renameSync(temporary, target);
    } catch { throw new Error('NATIVE_PAYLOAD_WRITE_FAILED: Check the project native directory and restart.'); }
  }
  return directory;
}

/** Reproducible, licensed local copy; never modify installed node-pty or donor source. */
export function prepareSourcePayload(root: string): { directory: string; manifest: NativeManifest } {
  const packageRoot = assertManagedPath(root, path.join(root, 'node_modules/node-pty'));
  if (JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version !== '1.2.0-beta.14') throw new Error('NATIVE_PATCH_VERSION_MISMATCH');
  const files = new Map<string, Uint8Array>();
  function collect(relative: string): void {
    const directory = assertManagedPath(root, path.join(packageRoot, relative));
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = `${relative}/${item.name}`;
      if (item.isDirectory()) collect(name);
      else if (item.name.endsWith('.js') && !item.name.endsWith('.test.js')) {
        let bytes = fs.readFileSync(assertManagedPath(root, path.join(packageRoot, name)));
        if (name === 'lib/windowsPtyAgent.js') {
          const original = "(0, child_process_1.fork)(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()])";
          const source = bytes.toString('utf8');
          if (!source.includes(original)) throw new Error('NATIVE_PATCH_VERSION_MISMATCH');
          const cleanup = 'this._outSocket.destroy();\n    };';
          if (!source.includes(cleanup)) throw new Error('NATIVE_PATCH_VERSION_MISMATCH');
          const startup = "this._outSocket.on('connect', function () {";
          if (!source.includes(startup)) throw new Error('NATIVE_PATCH_VERSION_MISMATCH');
          bytes = Buffer.from(source.replace(original,
            "(0, child_process_1.fork)(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()], { windowsHide: true, execArgv: [], env: Object.assign({}, process.env, { GROTESQUERIES_HELPER_PID: _this._innerPid.toString() }) })")
            .replace(cleanup, 'this._outSocket.destroy();\n        this._inSocket.destroy();\n        this._conoutSocketWorker.dispose();\n        this._ptyNative.kill(this._pty, this._useConptyDll);\n    };')
            .replace(startup,
              'this._cancelStartup = function () {\n' +
              '            if (!this._pendingPtyInfo) return Promise.resolve();\n' +
              '            clearTimeout(connectionTimeout);\n' +
              '            this._pendingPtyInfo = undefined;\n' +
              '            this._inSocket.destroy();\n' +
              '            this._outSocket.destroy();\n' +
              '            this._ptyNative.kill(this._pty, this._useConptyDll);\n' +
              '            return this._conoutSocketWorker._worker.terminate();\n' +
              '        };\n        ' + startup));
        }
        if (name === 'lib/windowsTerminal.js') {
          const source = bytes.toString('utf8');
          const begin = source.indexOf("_this._socket.once('data', function () {");
          const end = source.indexOf('// Shutdown if', begin);
          if (begin < 0 || end < begin || !source.slice(begin, end).includes('_this._isReady = true;')) throw new Error('NATIVE_PATCH_VERSION_MISMATCH');
          // Native ready permits writes/resizes even when the CLI produces no output.
          bytes = Buffer.from(source.slice(0, begin) +
            'if (!_this._isReady) {\n' +
            '                _this._isReady = true;\n' +
            '                _this._deferreds.forEach(function (fn) { fn.run(); });\n' +
            '                _this._deferreds = [];\n' +
            '            }\n            ' + source.slice(end));
        }
        if (name === 'lib/worker/conoutSocketWorker.js') {
          const source = bytes.toString('utf8'); const pipe = 'conoutSocket.pipe(workerSocket);';
          if (!source.includes(pipe)) throw new Error('NATIVE_PATCH_VERSION_MISMATCH');
          bytes = Buffer.from(source.replace(pipe,
            "// Grotesqueries: owned Stop may close the parent while final output is flushing.\n" +
            "        workerSocket.on('error', function (error) {\n" +
            "            if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') throw error;\n" +
            "            conoutSocket.unpipe(workerSocket);\n" +
            "            workerSocket.destroy();\n" +
            "            conoutSocket.resume();\n" +
            "        });\n        " + pipe));
        }
        files.set(`node-pty/${name}`, bytes);
      }
    }
  }
  collect('lib');
  for (const name of ['package.json', 'LICENSE', 'prebuilds/win32-x64/conpty.node', 'prebuilds/win32-x64/conpty_console_list.node']) {
    files.set(`node-pty/${name}`, fs.readFileSync(assertManagedPath(root, path.join(packageRoot, name))));
  }
  const entries = [...files].map(([name, bytes]) => ({ path: name, bytes: bytes.byteLength, sha256: hash(bytes) }));
  const buildId = hash(Buffer.from(JSON.stringify(entries))).slice(0, 24);
  const manifest = { buildId, files: entries };
  return { directory: extractNativePayload(root, manifest, name => files.get(name)!), manifest };
}

export function sourceNativePayload(root: string): string { return prepareSourcePayload(root).directory; }

export function loadNativePty(payload: string): typeof import('node-pty') {
  return createRequire(path.join(payload, 'entry.cjs'))(path.join(payload, 'node-pty/lib/index.js')) as typeof import('node-pty');
}

export function queryConsoleProcesses(payload: string, ownedPid: number): Promise<number[]> {
  if (!Number.isSafeInteger(ownedPid) || ownedPid <= 0) throw new Error('INVALID_OWNED_PTY_PID');
  return new Promise((resolve, reject) => {
    const child = fork(path.join(payload, 'node-pty/lib/conpty_console_list_agent.js'), [String(ownedPid)], {
      windowsHide: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, GROTESQUERIES_HELPER_PID: String(ownedPid) },
    });
    let result: number[] | undefined;
    const timer = setTimeout(() => { child.kill(); reject(new Error('PTY_HELPER_TIMEOUT')); }, 5000);
    child.on('message', message => {
      const value = (message as { consoleProcessList?: unknown }).consoleProcessList;
      if (Array.isArray(value) && value.length <= 128 && value.every(pid => Number.isSafeInteger(pid) && pid > 0)) result = value;
    });
    child.once('error', () => { clearTimeout(timer); reject(new Error('PTY_HELPER_FAILED')); });
    child.once('exit', code => { clearTimeout(timer); if (code === 0 && result) resolve(result); else reject(new Error('PTY_HELPER_FAILED')); });
  });
}

/** SEA fork dispatch is exact-path/owned-PID/IPC only, before normal host startup. */
export function dispatchConsoleHelper(root: string, manifest: NativeManifest): boolean {
  if (process.argv.length !== 4) return false;
  const expected = assertManagedPath(root, path.join(root, '.runtime/native', manifest.buildId,
    'node-pty/lib/conpty_console_list_agent'));
  const actual = process.argv[2];
  if (actual.toLowerCase() !== expected.toLowerCase() && actual.toLowerCase() !== (expected + '.js').toLowerCase()) return false;
  const pid = process.argv[3];
  if (!/^[1-9][0-9]{0,9}$/.test(pid) || Number(pid) > 0xFFFFFFFF ||
    process.env.GROTESQUERIES_HELPER_PID !== pid || typeof process.send !== 'function') throw new Error('INVALID_PTY_HELPER_INVOCATION');
  const payload = extractNativePayload(root, manifest, name => {
    // The verified parent has already extracted every file; the helper cannot repair missing bytes.
    return fs.readFileSync(assertManagedPath(root, path.join(path.dirname(path.dirname(path.dirname(expected))), name)));
  });
  process.argv = [process.execPath, expected + '.js', pid];
  createRequire(path.join(payload, 'entry.cjs'))(expected + '.js');
  return true;
}
