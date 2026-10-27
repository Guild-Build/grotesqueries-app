import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupPosix } from '../app/services/setup-posix.js';

if (process.argv.slice(2).some(argument => argument !== '--package')) throw new Error('Usage: setup.js [--package]');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
console.log('Configuration ready: ' + setupPosix(root, process.argv.includes('--package')));
if (process.platform === 'darwin') console.log('Mac alpha: cleanup covers terminal-session members and observed descendants; rapidly detached daemons may escape tracking.');
