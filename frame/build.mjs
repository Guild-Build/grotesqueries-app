// Build the frame to dist/: index.html, assets/app.js, assets/app.css and assets/licenses.txt, and nothing else.
// The esbuild options are the viewer's at Grotesqueries 91c3215 (bin/build.mjs:18).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.dirname(fileURLToPath(import.meta.url));

export async function build(packageRoot = root) {
  const esbuild = await import('esbuild');
  const dist = path.join(packageRoot, 'dist');
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(packageRoot, 'src/index.html'), path.join(dist, 'index.html'));
  // app.css is esbuild's: application.ts imports xterm.css and assets/stylesheets/application.css.
  const { metafile } = await esbuild.build({
    entryPoints: [path.join(packageRoot, 'src/application.ts')],
    outfile: path.join(dist, 'assets/app.js'),
    bundle: true, conditions: ['grotesqueries-source'], format: 'esm', platform: 'browser', target: ['es2022'],
    minify: true, logLevel: 'info', metafile: true, absWorkingDir: packageRoot,
  });
  fs.writeFileSync(path.join(dist, 'assets/licenses.txt'), licensesText(bundledPackages(metafile, packageRoot)));
  return { metafile };
}

/** The packages whose files esbuild bundled: the nearest package.json above each input's real path, the frame's own excluded. */
export function bundledPackages(metafile, packageRoot = root) {
  const folders = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    let folder = path.dirname(path.resolve(packageRoot, input));
    while (folder !== packageRoot && !fs.existsSync(path.join(folder, 'package.json')) && path.dirname(folder) !== folder) {
      folder = path.dirname(folder);
    }
    if (folder !== packageRoot && fs.existsSync(path.join(folder, 'package.json'))) folders.add(folder);
  }
  return [...folders].map(folder => ({ folder, ...JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One section per package: name, version, licence id and the text of its own LICENSE file (requirement 4.1.1, ledger 0.9). */
export function licensesText(packages) {
  return packages.map(({ folder, name, version, license }) => {
    const file = fs.readdirSync(folder).find(entry => /^(licen[cs]e|copying)(\.|$)/i.test(entry));
    const firstParty = name === '@grotesqueries/protocol' && path.resolve(folder) === path.resolve(root, '../lib/protocol');
    const text = file ? fs.readFileSync(path.join(folder, file), 'utf8').trim()
      : firstParty ? fs.readFileSync(path.resolve(root, '../LICENSE'), 'utf8').trim()
        : license ? 'text not shipped by the package' : 'first-party, private, no licence declared';
    return `Package: ${name}\nVersion: ${version}\nLicence: ${license ?? 'none declared'}\n\n${text}\n`;
  }).join('\n' + '-'.repeat(78) + '\n\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await build(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
