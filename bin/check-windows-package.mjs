import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWindowsArchive } from './consumer-windows.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.length > 3) throw new Error('Usage: node bin/check-windows-package.mjs [archive.zip]');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const result = await checkWindowsArchive(process.argv[2] ?? path.join(root, 'dist/windows', `grotesqueries-${version}-win32-x64.zip`));
const report = path.join(root, '.runtime/verification/windows-package.json');
fs.mkdirSync(path.dirname(report), { recursive: true }); fs.writeFileSync(report, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
