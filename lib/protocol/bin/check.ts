/**
 * The plugin kit (requirement 2.4, row 4): `node dist/bin/check.js <plugin folder>...` checks each folder as the core's
 * loader does before containment, with the same rules from this package: the manifest's shape and structural paths
 * (decodePluginManifest, requirement 1.4), its name against the folder, links (K-02) and every import (A-05). It prints
 * `PASS <name>` or one `REFUSED <name>: <reason>` line per refusal, and exits 1 when any folder is refused.
 * Containment of placed paths needs the host's directories, so it stays the core's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePluginManifest, importChecked, importViolations } from '../src/index.ts';

function imports(folder: string, relative: string, refusals: string[]): void {
  for (const entry of fs.readdirSync(path.join(folder, relative), { withFileTypes: true })) {
    const file = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) refusals.push(`Plugin file ${file} is a junction or link.`);
    else if (entry.isDirectory()) imports(folder, file, refusals);
    else if (importChecked(file)) {
      for (const refused of importViolations(file, fs.readFileSync(path.join(folder, file), 'utf8'))) refusals.push(`File ${file} imports ${refused}.`);
    }
  }
}

/** Every refusal for one plugin folder, in the core's words; none means it passes. */
export function checkPlugin(folder: string): string[] {
  const refusals: string[] = [];
  // A plugin folder that is a junction or link is refused by name and never followed, as the core does (K-02, S2-F1).
  if (fs.lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink()) return ['Plugin folder is a junction or link.'];
  let manifest: unknown;
  try { manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8')); }
  catch { return ['manifest.json is missing or is not JSON.']; }
  try {
    const decoded = decodePluginManifest(manifest);
    if (decoded.name !== path.basename(folder)) refusals.push(`Manifest name ${decoded.name} does not match its folder.`);
  } catch (error) { refusals.push(error instanceof Error ? error.message : 'Unreadable manifest.'); }
  imports(folder, '', refusals);
  return refusals;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const folders = process.argv.slice(2);
  if (!folders.length) { console.error('Usage: node dist/bin/check.js <plugin folder>...'); process.exitCode = 2; }
  for (const folder of folders) {
    const name = path.basename(path.resolve(folder)), refusals = checkPlugin(path.resolve(folder));
    if (!refusals.length) console.log(`PASS ${name}`);
    for (const reason of refusals) console.log(`REFUSED ${name}: ${reason}`);
    if (refusals.length) process.exitCode = 1;
  }
}
