// Release matrix controller: qualify every fixed, published Guild build on this native target.
import fs from 'node:fs';
import path from 'node:path';
import { packageGuildKit, loadCatalog } from './package-guild-kit.mjs';
import { checkGuildKit } from './check-guild-kit.mjs';

const [runtimeArchive, providerDirectory] = process.argv.slice(2);
if (!runtimeArchive || !providerDirectory || process.argv.length !== 4) {
  throw new Error('Usage: node bin/qualify-guild-kits.mjs RUNTIME_ARCHIVE PROVIDER_INSTALL_DIRECTORY');
}
if (!['linux', 'win32'].includes(process.platform)) throw new Error('Guild binary kits are qualified on Linux and Windows only.');
// The pinned official npm package supplies the native CLI; never execute a shell wrapper.
const provider = path.resolve(providerDirectory, 'node_modules', '@anthropic-ai', `claude-code-${process.platform}-${process.arch}`);
const binaries = fs.readdirSync(provider, { recursive: true }).filter(name => path.basename(name) === (process.platform === 'win32' ? 'claude.exe' : 'claude'));
if (binaries.length !== 1) throw new Error('Expected exactly one installed native Claude executable.');
const claude = path.join(provider, binaries[0]);
const failures = [];
// Fixture paths, native output and request content can appear in exception messages.
function failureCodes(error, depth = 0) {
  if (!(error instanceof Error) || depth >= 5) return [];
  const phase = /^WINDOWS_CONTROLLER_(?:TIMEOUT|PHASE)_(?:started|type-ready|job-ready|created|resumed|signaled|stopped|disposed)$/.exec(error.message)?.[0];
  const code = phase ?? /^[A-Z][A-Z0-9_]{2,95}(?=:|$)/.exec(error.message)?.[0] ?? 'UNCLASSIFIED_ERROR';
  const nested = error instanceof AggregateError ? error.errors.slice(0, 4) : [error.cause];
  return [code, ...nested.flatMap(item => failureCodes(item, depth + 1))].slice(0, 20);
}
for (const build of loadCatalog().builds) {
  try {
    const kit = await packageGuildKit({ runtimeArchive, buildSlug: build.slug });
    const proof = await checkGuildKit(kit.archive, { runtimeArchive, claude });
    console.log(JSON.stringify({ qualified: true, build: build.slug, sha256: proof.sha256, checks: proof.checks.length }));
  } catch (error) {
    failures.push(build.slug);
    const report = { qualified: false, build: build.slug, failureCodes: failureCodes(error) };
    console.error(JSON.stringify(report));
    const output = path.resolve('dist/guild-kits');
    try {
      for (const directory of [path.dirname(output), output]) {
        if (!fs.lstatSync(directory, { throwIfNoEntry: false })) fs.mkdirSync(directory);
        if (!fs.lstatSync(directory).isDirectory()) throw new Error('GUILD_KIT_FAILURE_OUTPUT_INVALID');
      }
      fs.writeFileSync(path.join(output, build.slug + '.failure.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    } catch {
      console.error(JSON.stringify({ build: build.slug, error: 'GUILD_KIT_FAILURE_REPORT_NOT_WRITTEN' }));
    }
  }
}
if (failures.length) throw new Error(`Guild kit qualification failed: ${failures.join(', ')}`);
