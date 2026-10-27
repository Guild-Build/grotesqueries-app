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
for (const build of loadCatalog().builds) {
  try {
    const kit = await packageGuildKit({ runtimeArchive, buildSlug: build.slug });
    const proof = await checkGuildKit(kit.archive, { runtimeArchive, claude });
    console.log(JSON.stringify({ qualified: true, build: build.slug, sha256: proof.sha256, checks: proof.checks.length }));
  } catch (error) {
    failures.push(build.slug);
    console.error(JSON.stringify({ qualified: false, build: build.slug, error: error.message }));
  }
}
if (failures.length) throw new Error(`Guild kit qualification failed: ${failures.join(', ')}`);
