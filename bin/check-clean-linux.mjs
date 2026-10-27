import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const images = ['debian:bookworm-slim', 'ubuntu:22.04', 'ubuntu:24.04'];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
const dockerJson = args => JSON.parse(docker(args));

export function inspectConsumerArchive(archive) {
  assert.ok(fs.lstatSync(archive).isFile() && !fs.lstatSync(archive).isSymbolicLink(), 'Regular archive input');
  const sha256 = digest(fs.readFileSync(archive));
  assert.equal(fs.readFileSync(archive + '.sha256', 'utf8').trim(), `${sha256}  ${path.basename(archive)}`, 'Archive ingestion checksum');
  const env = { ...process.env, TAR_OPTIONS: '', COPYFILE_DISABLE: '1' };
  const list = execFileSync('/usr/bin/tar', ['-tzf', archive], { encoding: 'utf8', env, maxBuffer: 4 * 1024 * 1024 }).trim().split('\n');
  const folder = list[0].replace(/\/$/, '');
  const match = /^grotesqueries-\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?-linux-(arm64|x64)$/.exec(folder);
  assert.ok(match, 'A Linux package root');
  assert.ok(list.every(file => /^[A-Za-z0-9._/-]+$/.test(file) && !file.startsWith('/') &&
    file.startsWith(folder + '/') && file.split('/').every(part => part !== '..')), 'One contained archive root');
  const detail = execFileSync('/usr/bin/tar', ['-tvzf', archive], { encoding: 'utf8', env, maxBuffer: 4 * 1024 * 1024 }).trim().split('\n');
  assert.ok(detail.length === list.length && detail.every(line => /^[-d]/.test(line)), 'Only regular files and directories');
  return { folder, architecture: match[1], sha256 };
}

const consumerCommand = `
set -eu
for tool in node nodejs npm npx cc gcc clang make; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "Unexpected preinstalled development tool: $tool" >&2
    exit 1
  fi
done
test "$(id -u)" -ne 0
printf '{"cleanBase":true,"uid":%s,"toolsAbsent":["node","nodejs","npm","npx","cc","gcc","clang","make"]}\\n' "$(id -u)"
mkdir /work/consumer
tar --no-same-owner -xzf /input/archive.tar.gz -C /work/consumer
cd "/work/consumer/$1"
exec ./bin/node /input/consumer-smoke.mjs "$PWD" --disposable
`;

/** Test one immutable Linux archive against clean root filesystems, on the Docker engine's native CPU. */
export function checkCleanLinux(archive) {
  archive = path.resolve(archive);
  const input = inspectConsumerArchive(archive);
  const engine = dockerJson(['info', '--format', '{{json .}}']);
  const engineArch = ({ aarch64: 'arm64', arm64: 'arm64', x86_64: 'x64', amd64: 'x64' })[engine.Architecture];
  assert.equal(engineArch, input.architecture, 'Clean tests require native architecture, not emulation');
  const platform = 'linux/' + (input.architecture === 'x64' ? 'amd64' : 'arm64');
  const checker = fs.realpathSync(path.join(root, 'bin/consumer-smoke.mjs'));
  const results = [];
  for (const image of images) {
    const nonce = crypto.randomUUID();
    const name = 'grotesqueries-clean-' + nonce;
    let created = false, result = { image, passed: false };
    try {
      console.log('Clean consumer image: ' + image + ' (' + platform + ')');
      docker(['pull', '--platform', platform, image]);
      const inspectedImage = dockerJson(['image', 'inspect', image])[0];
      const repository = image.split(':')[0];
      const immutableImage = inspectedImage.RepoDigests.find(value => value.startsWith(repository + '@sha256:'));
      assert.ok(immutableImage, 'Official image has a registry digest');
      docker(['create', '--name', name, '--label', 'io.guildbuild.clean-test=' + nonce,
        '--platform', platform, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--user', '65534:65534',
        '--tmpfs', '/work:rw,nosuid,nodev,exec,size=512m,mode=1777',
        '--mount', `type=bind,source=${archive},target=/input/archive.tar.gz,readonly`,
        '--mount', `type=bind,source=${checker},target=/input/consumer-smoke.mjs,readonly`,
        '--entrypoint', '/bin/sh', immutableImage, '-c', consumerCommand, 'consumer-check', input.folder]);
      created = true;
      const container = dockerJson(['inspect', name])[0];
      assert.equal(container.HostConfig.ReadonlyRootfs, true);
      assert.equal(container.HostConfig.NetworkMode, 'none');
      assert.equal(container.Config.User, '65534:65534');
      assert.deepEqual(container.HostConfig.CapDrop, ['ALL']);
      assert.ok(container.HostConfig.SecurityOpt.includes('no-new-privileges'));
      assert.ok(container.Mounts.every(mount => mount.Type !== 'bind' || mount.RW === false));
      const output = docker(['start', '--attach', name]);
      const state = dockerJson(['inspect', name])[0].State;
      assert.equal(state.ExitCode, 0, 'Consumer process exit');
      const records = output.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      const base = records.find(record => record.cleanBase === true);
      const consumer = records.find(record => record.consumerChecked === true);
      assert.equal(base?.uid, 65534); assert.equal(consumer?.uid, 65534);
      assert.ok(consumer.checks.includes('root-exited-descendant-cleanup'));
      result = { image, immutableImage, imageId: inspectedImage.Id, passed: true,
        isolation: { network: 'none', user: '65534:65534', readOnlyRootFilesystem: true,
          droppedCapabilities: ['ALL'], noNewPrivileges: true, sourceCheckoutMounted: false }, base, consumer };
      console.log(JSON.stringify({ cleanConsumerImagePassed: true, image, immutableImage, checks: consumer.checks.length }));
    } catch (error) {
      result.error = String(error.message);
      if (error.stderr) result.detail = String(error.stderr).slice(-8192);
      console.error(JSON.stringify({ cleanConsumerImagePassed: false, image, error: result.error, detail: result.detail }));
    } finally {
      if (created) {
        const classified = dockerJson(['inspect', name])[0];
        if (classified.Config.Labels['io.guildbuild.clean-test'] !== nonce) throw new Error('CLEAN_CONTAINER_OWNERSHIP_CHANGED');
        const removed = spawnSync('docker', ['rm', '--force', name], { encoding: 'utf8', timeout: 30000 });
        if (removed.status !== 0) throw new Error('CLEAN_CONTAINER_CLEANUP_FAILED');
      }
    }
    results.push(result);
  }
  const report = { cleanLinuxChecked: results.every(result => result.passed), archive: path.basename(archive),
    artifactSha256: input.sha256, architecture: input.architecture, dockerEngine: engine.ServerVersion,
    kernelScope: 'Containers share the Docker engine kernel; these results qualify clean root filesystems, not additional kernels.',
    results };
  const directory = path.join(root, '.runtime/verification/clean-linux');
  for (let current = root, parts = ['.runtime', 'verification', 'clean-linux']; parts.length;) {
    current = path.join(current, parts.shift());
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('CLEAN_REPORT_PATH_SYMLINK');
  }
  fs.mkdirSync(directory, { recursive: true });
  const reportFile = path.join(directory, input.sha256 + '.json');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ cleanLinuxChecked: report.cleanLinuxChecked, report: reportFile, artifactSha256: input.sha256 }));
  if (!report.cleanLinuxChecked) throw new Error('CLEAN_LINUX_MATRIX_FAILED: See ' + reportFile);
  return { report, reportFile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node bin/check-clean-linux.mjs <linux-archive.tar.gz>');
  checkCleanLinux(process.argv[2]);
}
