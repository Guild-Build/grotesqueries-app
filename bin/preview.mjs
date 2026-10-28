// Private compatibility preview. Keep operator configuration and existing sessions separate.
import fs from 'node:fs';
import path from 'node:path';
import { root, frameFolder } from './build.mjs';
import { assertManagedPath, managedDirectory } from '../lib/local-web/runtime.ts';

const directory = managedDirectory(root, path.join(root, '.runtime', 'preview'));
const file = assertManagedPath(root, path.join(directory, 'grotesqueries.json'));
const template = JSON.parse(fs.readFileSync(path.join(root, 'config', 'preview.json'), 'utf8'));
template.frame = path.relative(directory, frameFolder());
try { fs.writeFileSync(file, JSON.stringify(template, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
process.env.GROTESQUERIES_CONFIG = file;
console.log('Source compatibility preview: no launch profiles are installed.');
console.log(`Configuration: ${file}`);
await import('./start.mjs');
