import fs from 'node:fs';
import path from 'node:path';
import { root } from './build.mjs';

if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Use npm start for the Windows configuration.');
process.env.GROTESQUERIES_CONFIG ??= path.join(root, '.runtime/posix/grotesqueries.json');
if (!fs.existsSync(process.env.GROTESQUERIES_CONFIG)) throw new Error('Run npm run setup:posix before starting native sessions.');
await import('./start.mjs');
