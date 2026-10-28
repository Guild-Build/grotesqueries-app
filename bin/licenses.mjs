import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

export function assertSourceNode(root, actualVersion = process.version) {
  const required = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).engines?.node;
  if (typeof required !== 'string' || !/^\d+\.\d+\.\d+$/.test(required)) throw new Error('NODE_VERSION_PIN_INVALID: Source builds need an exact Node version in package.json.');
  if (actualVersion !== 'v' + required) throw new Error(`NODE_VERSION_UNSUPPORTED: Grotesqueries source builds require Node.js v${required}; found ${actualVersion}. Select Node ${required} in this shell, then retry. If you use nvm: nvm install ${required} && nvm use ${required}.`);
}

export function distributionMetadata(root) {
  const require = createRequire(path.join(root, 'app/package.json'));
  const names = ['node-pty', 'ws', '@xterm/headless', '@xterm/addon-serialize', '@xterm/xterm', '@xterm/addon-unicode11'];
  const versions = {}; const notices = [
    '===== Grotesqueries — Apache License 2.0 =====\n' + fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'),
    fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')];
  for (const name of names) {
    let entry = require.resolve(name); let directory = path.dirname(entry);
    while (!fs.existsSync(path.join(directory, 'package.json'))) { const parent = path.dirname(directory); if (parent === directory) throw new Error('LICENSE_PACKAGE_NOT_FOUND'); directory = parent; }
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')); versions[name] = metadata.version;
    const license = ['LICENSE', 'LICENSE.txt', 'LICENSE.md'].find(file => fs.existsSync(path.join(directory, file)));
    // These two published xterm tarballs omit the repository-wide MIT file.
    // Retain that same pinned repository license from its browser package.
    const sharedXterm = ['@xterm/headless', '@xterm/addon-serialize'].includes(name) && metadata.license === 'MIT';
    const licensePath = license ? path.join(directory, license) : sharedXterm ? path.join(root, 'node_modules/@xterm/xterm/LICENSE') : undefined;
    if (!licensePath) throw new Error('LICENSE_NOT_FOUND: ' + name);
    notices.push('\n\n===== ' + name + ' ' + metadata.version + ' =====\n' + fs.readFileSync(licensePath, 'utf8'));
    if (fs.existsSync(path.join(directory, 'NOTICE'))) notices.push(fs.readFileSync(path.join(directory, 'NOTICE'), 'utf8'));
  }
  const nodeLicense = fs.readFileSync(path.join(root, 'vendor/licenses/node-v24.14.1-LICENSE.txt'));
  if (process.version !== 'v24.14.1' || crypto.createHash('sha256').update(nodeLicense).digest('hex') !== '4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18') throw new Error('NODE_LICENSE_VERSION_MISMATCH: Pin the matching official Node distribution license before building.');
  notices.push('\n\n===== Node.js ' + process.version + ' and bundled third-party libraries =====\n' + nodeLicense.toString('utf8'));
  const output = path.join(root, 'public'); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'licenses.txt'), notices.join('\n'));
  fs.copyFileSync(path.join(root, 'config/grotesqueries.schema.json'), path.join(output, 'grotesqueries.schema.json'));
  fs.writeFileSync(path.join(output, 'version.json'), JSON.stringify({ application: 'grotesqueries', version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, protocol: 4,
    platform: process.platform, architecture: process.arch,
    ...(process.platform === 'win32' ? { minimumWindowsBuild: 18309 } : {}), unicodeWidthVersion: '11', node: process.version, nodeAbi: process.versions.modules, dependencies: versions }));
}
