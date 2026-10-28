// SEA composition reuses the reviewed Grotesqueries implementation at
// 792e0ee2641525c61e496f863b634976e8f0b419; defaults and release archive are public-only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, crc32 } from 'node:zlib';
import { inject } from 'postject';
import * as esbuild from 'esbuild';
import { root } from './build.mjs';
import { distributionMetadata } from './licenses.mjs';
import { runtimeEnvironment } from './runtime.mjs';
import { frameAssets } from './frame-assets.mjs';
import { seaConfig } from './sea-config.mjs';
import { assertNoEmbeddedAuthenticode, stripAuthenticodeSignature } from './windows-pe.mjs';
export { stripAuthenticodeSignature } from './windows-pe.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function defaultWindowsConfiguration() {
  return { version: 1, port: 8765, allowedProjectDirectories: ['.'],
    launchProfiles: [{ id: 'powershell', label: 'PowerShell', executable: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile'], projectDirectory: '.', environment: {} }],
    terminal: { scrollbackLines: 10000, recentOutputBytes: 8388608, maxIncompleteSequenceBytes: 65536 },
    diagnostics: { directory: '.runtime/logs', maxFiles: 4, maxFileBytes: 1048576 } };
}

/** Stable file order, timestamps and compression for a given set of release bytes. No ZIP64 or links. */
export function windowsZip(entries, epoch) {
  const date = new Date(epoch * 1000);
  if (!Number.isSafeInteger(epoch) || date.getUTCFullYear() < 1980 || date.getUTCFullYear() > 2107) throw new Error('WINDOWS_ZIP_DATE_INVALID');
  if (!Array.isArray(entries) || !entries.length || entries.length > 64) throw new Error('WINDOWS_ZIP_ENTRIES_INVALID');
  const time = date.getUTCHours() << 11 | date.getUTCMinutes() << 5 | date.getUTCSeconds() >> 1;
  const day = date.getUTCFullYear() - 1980 << 9 | date.getUTCMonth() + 1 << 5 | date.getUTCDate();
  const local = [], central = [], seen = new Set(); let offset = 0;
  for (const entry of [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (typeof entry.name !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(entry.name) || entry.name.startsWith('/') ||
      entry.name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)) || seen.has(entry.name.toLowerCase())) {
      throw new Error('WINDOWS_ZIP_PATH_INVALID');
    }
    seen.add(entry.name.toLowerCase());
    const name = Buffer.from(entry.name), data = Buffer.from(entry.bytes);
    if (name.length > 65535 || data.length > 192 * 1024 * 1024) throw new Error('WINDOWS_ZIP_SIZE_INVALID');
    const packed = deflateRawSync(data, { level: 9 }), checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8); header.writeUInt16LE(time, 10); header.writeUInt16LE(day, 12);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(8, 10); record.writeUInt16LE(time, 12); record.writeUInt16LE(day, 14);
    record.writeUInt32LE(checksum, 16); record.writeUInt32LE(packed.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
    local.push(header, name, packed); central.push(record, name); offset += header.length + name.length + packed.length;
    if (offset > 256 * 1024 * 1024) throw new Error('WINDOWS_ZIP_SIZE_INVALID');
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function regular(file) {
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('WINDOWS_PACKAGE_INPUT_NOT_REGULAR: ' + file);
  return fs.readFileSync(file);
}

export async function packageWindows() {
  if (process.platform !== 'win32' || process.arch !== 'x64' || process.version !== 'v24.14.1') throw new Error('WINDOWS_X64_NODE_24_14_1_REQUIRED');
  const metadata = JSON.parse(regular(path.join(root, 'package.json')));
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(metadata.version)) throw new Error('WINDOWS_PACKAGE_VERSION_INVALID');
  const name = `grotesqueries-${metadata.version}-win32-x64`, output = path.join(root, 'dist/windows');
  for (const directory of [path.join(root, 'dist'), output]) {
    if (fs.existsSync(directory) && (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory())) throw new Error('WINDOWS_PACKAGE_OUTPUT_INVALID');
  }
  fs.mkdirSync(output, { recursive: true });
  const archive = path.join(output, name + '.zip'), checksum = archive + '.sha256';
  if (fs.existsSync(archive) || fs.existsSync(checksum)) throw new Error('WINDOWS_PACKAGE_OUTPUT_EXISTS: Preserve the existing artifact; build in a new clean checkout.');
  if (process.env.AUTOMATA_FRAME && path.resolve(process.env.AUTOMATA_FRAME) !== path.join(root, 'frame/dist')) throw new Error('WINDOWS_FRAME_OVERRIDE_NOT_ALLOWED');
  distributionMetadata(root);
  const frame = frameAssets(path.join(root, 'frame/dist'));
  const stage = fs.mkdtempSync(path.join(output, '.stage-'));
  try {
    const payloadModule = path.join(stage, 'payload.cjs');
    await esbuild.build({ entryPoints: [path.join(root, 'app/services/native-payload.ts')], outfile: payloadModule,
      bundle: true, conditions: ['grotesqueries-source'], format: 'cjs', platform: 'node', target: 'node24' });
    const { prepareSourcePayload } = createRequire(import.meta.url)(payloadModule);
    const payload = prepareSourcePayload(root), nativeManifest = payload.manifest;
    const assets = Object.fromEntries(nativeManifest.files.map(file => ['native/' + file.path, path.join(payload.directory, file.path)]));
    const manifestFile = path.join(stage, 'native-manifest.json');
    fs.writeFileSync(manifestFile, JSON.stringify(nativeManifest)); assets['native-manifest.json'] = manifestFile;
    for (const file of ['licenses.txt', 'grotesqueries.schema.json', 'version.json']) assets['web/' + file] = path.join(root, 'public', file);
    Object.assign(assets, frame); assets['THIRD_PARTY_NOTICES.md'] = path.join(root, 'THIRD_PARTY_NOTICES.md');
    for (const file of Object.values(assets)) regular(file);
    const bundle = path.join(stage, 'sea-entry.cjs'), blob = path.join(stage, 'sea.blob'), config = path.join(stage, 'sea-config.json');
    await esbuild.build({ entryPoints: [path.join(root, 'config/standalone.ts')], outfile: bundle,
      bundle: true, conditions: ['grotesqueries-source'], format: 'cjs', platform: 'node', target: 'node24', external: ['node-pty'],
      define: { GROTESQUERIES_PROBE: 'false' } });
    fs.writeFileSync(config, JSON.stringify(seaConfig(bundle, blob, assets)));
    execFileSync(process.execPath, ['--experimental-sea-config', config], { cwd: root, env: runtimeEnvironment(), stdio: 'pipe' });
    const executable = path.join(stage, 'grotesqueries.exe'), nodeBytes = regular(process.execPath);
    fs.writeFileSync(executable, stripAuthenticodeSignature(nodeBytes), { flag: 'wx' });
    await inject(executable, 'NODE_SEA_BLOB', regular(blob), { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' });
    const executableBytes = regular(executable);
    assertNoEmbeddedAuthenticode(executableBytes);
    const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const sourceDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).trim() !== '';
    const buildMetadata = { application: metadata.name, version: metadata.version, releaseChannel: 'native-alpha',
      platform: 'win32', architecture: 'x64', node: process.version, nodeAbi: process.versions.modules,
      guildBuildPresetVersion: 1,
      minimumWindowsBuild: 18309, sourceRevision, sourceDirty, signing: 'unsigned', nativeCleanup: 'tracked-descendants',
      nodeBinarySha256: hash(nodeBytes), executableSha256: hash(executableBytes), nativeBuildId: nativeManifest.buildId };
    const files = new Map([
      ['grotesqueries.exe', executableBytes],
      ['grotesqueries.json', Buffer.from(JSON.stringify(defaultWindowsConfiguration(), null, 2) + '\n')],
      ['BUILD-METADATA.json', Buffer.from(JSON.stringify(buildMetadata, null, 2) + '\n')],
      ['LICENSE', regular(path.join(root, 'LICENSE'))], ['THIRD_PARTY_NOTICES.md', regular(path.join(root, 'THIRD_PARTY_NOTICES.md'))],
      ['licenses.txt', regular(path.join(root, 'public/licenses.txt'))],
      ['README.txt', Buffer.from([
        'Grotesqueries Windows x64 native alpha',
        'Extract this ZIP into a writable local folder. Keep grotesqueries.exe and grotesqueries.json together.',
        'In PowerShell, run .\\grotesqueries.exe --setup to discover installed shells/CLIs, then .\\grotesqueries.exe.',
        'Open http://127.0.0.1:8765 unless you changed the configured port. Choose Start session, then Take control to type.',
        'Node, npm and a compiler are not required to run this package. Selected CLIs and their provider accounts remain your responsibility.',
        'Ctrl+C in the host console requests shutdown and owned-session cleanup. Closing a browser tab leaves its session running.',
        'Host restart does not restore live terminal processes. Keep the listener on loopback.',
        'This executable is unsigned. Windows may show an unknown-publisher or SmartScreen warning; do not disable or bypass operating-system protection.',
        'Requires Windows x64 with ConPTY (build 18309 or later). Qualification identifies the actual tested Windows version.',
        'SHA256SUMS identifies the original packaged files; grotesqueries.json is editable operator configuration.',
        'Software is Apache-2.0; third-party components retain their licenses. See licenses.txt and BUILD-METADATA.json.',
        '',
      ].join('\r\n'))],
    ]);
    files.set('SHA256SUMS', Buffer.from([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([file, bytes]) => `${hash(bytes)}  ${file}\n`).join('')));
    const epoch = Number(execFileSync('git', ['show', '-s', '--format=%ct', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
    const archiveBytes = windowsZip([...files].map(([file, bytes]) => ({ name: name + '/' + file, bytes })), epoch);
    fs.writeFileSync(archive, archiveBytes, { flag: 'wx' });
    const archiveSha256 = hash(archiveBytes); fs.writeFileSync(checksum, `${archiveSha256}  ${path.basename(archive)}\n`, { flag: 'wx' });
    // Test-tool dependency is bundled separately; no development package is needed on the fresh consumer VM.
    await esbuild.build({ entryPoints: [path.join(root, 'bin/consumer-windows.mjs')], outfile: path.join(output, 'consumer-windows.mjs'),
      bundle: true, platform: 'node', format: 'esm', target: 'node24',
      banner: { js: "import { createRequire as windowsConsumerRequire } from 'node:module'; const require = windowsConsumerRequire(import.meta.url);" } });
    const result = { archive, checksum, sha256: archiveSha256, bytes: archiveBytes.length, files: files.size, metadata: buildMetadata };
    console.log(JSON.stringify({ packaged: true, ...result })); return result;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await packageWindows();
