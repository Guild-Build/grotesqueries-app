import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MACOS_DEPLOYMENT_TARGET } from './native-build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const nativeHelpers = { darwin: 'macos-processes', linux: 'linux-supervisor' };

function regular(file) {
  const value = fs.lstatSync(file);
  if (!value.isFile() || value.isSymbolicLink()) throw new Error(`PACKAGE_INPUT_NOT_REGULAR: ${file}`);
  return value;
}

function sourcePath(base, relative) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..')) throw new Error('PACKAGE_INPUT_ESCAPES_SOURCE');
  let current = base;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`PACKAGE_INPUT_SYMLINK: ${current}`);
  }
  return current;
}

function copyFile(source, destination) {
  const stat = regular(source);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, stat.mode & 0o777);
}

function copyJavaScript(source, destination) {
  const value = fs.lstatSync(source);
  if (!value.isDirectory() || value.isSymbolicLink()) throw new Error(`PACKAGE_INPUT_NOT_DIRECTORY: ${source}`);
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`PACKAGE_INPUT_SYMLINK: ${from}`);
    if (entry.isDirectory()) copyJavaScript(from, to);
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) copyFile(from, to);
  }
}

function filesIn(directory, relative = '') {
  const result = [];
  for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`PACKAGE_OUTPUT_SYMLINK: ${name}`);
    if (entry.isDirectory()) result.push(...filesIn(directory, name));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`PACKAGE_OUTPUT_NOT_REGULAR: ${name}`);
  }
  return result;
}

/** Inspect all shipped Mach-O files, rather than inferring compatibility from the build host. */
export function inspectMacPayload(folder) {
  if (process.platform !== 'darwin') throw new Error('MACOS_INSPECTION_UNSUPPORTED');
  const expected = ['bin/node', 'dist/native/macos-processes',
    `node_modules/node-pty/prebuilds/darwin-${process.arch}/pty.node`,
    `node_modules/node-pty/prebuilds/darwin-${process.arch}/spawn-helper`].sort();
  const magic = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
  const found = filesIn(folder).filter(file => {
    const descriptor = fs.openSync(path.join(folder, file), 'r'); const bytes = Buffer.alloc(4);
    try { return fs.readSync(descriptor, bytes, 0, 4, 0) === 4 && magic.has(bytes.toString('hex')); }
    finally { fs.closeSync(descriptor); }
  }).sort();
  if (JSON.stringify(found) !== JSON.stringify(expected)) throw new Error('MACOS_MACHO_INVENTORY_MISMATCH');
  return found.map(file => {
    const binary = path.join(folder, file);
    const architecture = execFileSync('/usr/bin/lipo', ['-archs', binary], { encoding: 'utf8' }).trim();
    if (architecture !== (process.arch === 'x64' ? 'x86_64' : 'arm64')) throw new Error('MACOS_MACHO_ARCHITECTURE_MISMATCH: ' + file);
    const build = execFileSync('/usr/bin/xcrun', ['vtool', '-show-build', binary], { encoding: 'utf8' });
    if (!/\bplatform MACOS\b|\bLC_VERSION_MIN_MACOSX\b/.test(build)) throw new Error('MACOS_MACHO_PLATFORM_MISMATCH: ' + file);
    const minimum = /\bminos\s+(\d+(?:\.\d+){0,2})\b/.exec(build)?.[1]
      ?? /\bversion\s+(\d+(?:\.\d+){0,2})\b/.exec(build)?.[1];
    if (!minimum || minimum.split('.').some((value, index) => Number(value) > Number(MACOS_DEPLOYMENT_TARGET.split('.')[index] ?? 0) &&
      minimum.split('.').slice(0, index).every((prefix, i) => Number(prefix) === Number(MACOS_DEPLOYMENT_TARGET.split('.')[i] ?? 0)))) {
      throw new Error('MACOS_MINIMUM_OS_MISMATCH: ' + file);
    }
    return { file, architecture, minimumMacOS: minimum };
  });
}

/** Produce one self-contained alpha archive for the current native OS/CPU. Build first. */
export function packagePosix(sourceRoot = root) {
  const helper = nativeHelpers[process.platform];
  if (!helper || !['arm64', 'x64'].includes(process.arch)) throw new Error('POSIX_PACKAGE_TARGET_UNSUPPORTED');
  if (process.version !== 'v24.14.1') throw new Error('POSIX_PACKAGE_NODE_VERSION: Build with Node 24.14.1.');
  sourceRoot = fs.realpathSync(sourceRoot);
  const metadata = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(metadata.version)) throw new Error('POSIX_PACKAGE_VERSION_INVALID');
  const name = `grotesqueries-${metadata.version}-${process.platform}-${process.arch}`;
  sourcePath(sourceRoot, 'dist');
  const output = path.join(sourceRoot, 'dist', 'posix');
  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) throw new Error('PACKAGE_OUTPUT_ESCAPES_SOURCE');
  fs.mkdirSync(output, { recursive: true });
  if (fs.lstatSync(output).isSymbolicLink() || !fs.realpathSync(output).startsWith(sourceRoot + path.sep)) throw new Error('PACKAGE_OUTPUT_ESCAPES_SOURCE');
  const stage = fs.mkdtempSync(path.join(output, '.stage-'));
  const folder = path.join(stage, name);
  const archive = path.join(output, `${name}.tar.gz`);
  const partialArchive = path.join(stage, `${name}.tar.gz`);
  try {
    fs.mkdirSync(folder);
    const copy = (from, to = from) => copyFile(sourcePath(sourceRoot, from), path.join(folder, to));
    for (const file of ['dist/host/server.js', 'dist/host/setup.js', `dist/native/${helper}`,
      'public/licenses.txt', 'public/grotesqueries.schema.json', 'public/version.json',
      'frame/dist/index.html', 'frame/dist/assets/app.js', 'frame/dist/assets/app.css', 'frame/dist/assets/licenses.txt',
      'LICENSE', 'THIRD_PARTY_NOTICES.md', 'vendor/licenses/node-v24.14.1-LICENSE.txt']) copy(file);
    fs.mkdirSync(path.join(folder, 'config'));
    copyFile(process.execPath, path.join(folder, 'bin/node'));
    fs.chmodSync(path.join(folder, 'bin/node'), 0o755);
    fs.chmodSync(path.join(folder, 'dist/native', helper), 0o755);
    for (const packageName of ['node-pty', 'ws']) {
      const source = sourcePath(sourceRoot, `node_modules/${packageName}`);
      if (fs.lstatSync(source).isSymbolicLink()) throw new Error(`PACKAGE_INPUT_SYMLINK: ${source}`);
      for (const file of ['package.json', 'LICENSE']) copy(`node_modules/${packageName}/${file}`);
      copyJavaScript(path.join(source, 'lib'), path.join(folder, 'node_modules', packageName, 'lib'));
    }
    for (const file of ['index.js', 'wrapper.mjs']) copy(`node_modules/ws/${file}`);
    const prebuild = `node_modules/node-pty/prebuilds/${process.platform}-${process.arch}`;
    const prebuildRoot = sourcePath(sourceRoot, prebuild);
    if (fs.lstatSync(prebuildRoot).isSymbolicLink()) throw new Error(`PACKAGE_INPUT_SYMLINK: ${prebuildRoot}`);
    copy(`${prebuild}/pty.node`);
    if (process.platform === 'darwin') { copy(`${prebuild}/spawn-helper`); fs.chmodSync(path.join(folder, prebuild, 'spawn-helper'), 0o755); }
    fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version,
      private: true, type: 'module', license: 'Apache-2.0' }, null, 2) + '\n');
    const launcher = `#!/bin/sh\nset -eu\nAPP_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\nif [ "\${1-}" = "--setup" ]; then\n  shift\n  exec "$APP_ROOT/bin/node" "$APP_ROOT/dist/host/setup.js" --package "$@"\nfi\nif [ "$#" -ne 0 ]; then\n  echo 'Usage: grotesqueries [--setup]' >&2\n  exit 2\nfi\nif [ ! -f "$APP_ROOT/config/grotesqueries.json" ]; then\n  "$APP_ROOT/bin/node" "$APP_ROOT/dist/host/setup.js" --package\nfi\nexec "$APP_ROOT/bin/node" "$APP_ROOT/dist/host/server.js"\n`;
    fs.writeFileSync(path.join(folder, 'grotesqueries'), launcher, { mode: 0o755 });
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== '';
    const buildMetadata = { application: metadata.name, version: metadata.version, releaseChannel: 'native-alpha',
      platform: process.platform, architecture: process.arch, node: process.version, nodeAbi: process.versions.modules,
      sourceRevision: revision, sourceDirty: dirty, guildBuildPresetVersion: 1, signing: process.platform === 'darwin' ? 'unsigned-and-unnotarized' : 'unsigned',
      nativeCleanup: process.platform === 'darwin' ? 'tracked-descendants' : 'per-session-subreaper',
      nodeBinarySha256: sha256(fs.readFileSync(process.execPath)) };
    if (process.platform === 'darwin') Object.assign(buildMetadata, {
      minimumMacOS: MACOS_DEPLOYMENT_TARGET, machOBinaries: inspectMacPayload(folder),
    });
    fs.writeFileSync(path.join(folder, 'BUILD-METADATA.json'), JSON.stringify(buildMetadata, null, 2) + '\n');
    fs.writeFileSync(path.join(folder, 'README.txt'), [
      'Grotesqueries native alpha',
      `Target: ${process.platform} ${process.arch}. Includes Node ${process.version}.`,
      'Extract into a writable local folder. Run ./grotesqueries --setup, then ./grotesqueries.',
      'Open http://127.0.0.1:8765 unless you changed the configured port. Ctrl+C stops this host.',
      'Configuration is created at config/grotesqueries.json. Setup preserves existing settings.',
      'The app needs no installed Node, npm, or compiler. Profiles still require their selected shells/CLIs and authentication.',
      process.platform === 'darwin' ? 'This Mac alpha is unsigned and unnotarized. Do not bypass operating-system security warnings.' : 'This Linux alpha requires a kernel with child-subreaper and pidfd support.',
      process.platform === 'darwin' ? 'Mac Stop verifies tracked processes. A daemon that detaches before observation may remain running.' : 'Linux sessions use a dedicated child-subreaper to retain descendant ownership through cleanup.',
      'SHA256SUMS checks packaged file integrity. The tarball SHA-256 sidecar checks the downloaded archive.',
      'Project source is licensed Apache-2.0. Third-party notices retain their own licenses.',
      'This alpha is not a production certification. See BUILD-METADATA.json and the source release notes.',
      '',
    ].join('\n'));
    const fileList = filesIn(folder);
    fs.writeFileSync(path.join(folder, 'SHA256SUMS'), fileList.map(file => `${sha256(fs.readFileSync(path.join(folder, file)))}  ${file}\n`).join(''));
    const epoch = Number(execFileSync('git', ['show', '-s', '--format=%ct', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim());
    for (const file of [...fileList, 'SHA256SUMS']) fs.utimesSync(path.join(folder, file), epoch, epoch);
    const ownership = process.platform === 'darwin' ? ['--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root'] : ['--owner=0', '--group=0', '--numeric-owner'];
    execFileSync('/usr/bin/tar', [...ownership, '-czf', partialArchive, '-C', stage, name], { env: { ...process.env, COPYFILE_DISABLE: '1', TAR_OPTIONS: '' }, stdio: 'pipe' });
    fs.renameSync(partialArchive, archive);
    const archiveSha256 = sha256(fs.readFileSync(archive));
    const checksum = archive + '.sha256';
    fs.writeFileSync(checksum, `${archiveSha256}  ${path.basename(archive)}\n`);
    const result = { archive, checksum, sha256: archiveSha256, files: fileList.length + 1, metadata: buildMetadata };
    console.log(JSON.stringify({ packaged: true, ...result }));
    return result;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) packagePosix();
