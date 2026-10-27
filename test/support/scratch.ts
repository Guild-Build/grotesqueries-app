import fs from 'node:fs';
import path from 'node:path';

// Requirement 4.1.1, L3-1: a test's scratch under the tree's .runtime is its own folder, removed when its process ends,
// pass or fail. The removal runs on process exit rather than in a node:test hook, so the fixtures that bin/ scripts also
// load can use it. Junctions are unlinked, never followed (hazard 3).
const made: string[] = [];
let registered = false;

export function scratchDirectory(prefix: string, root = process.cwd()): string {
  if (!registered) { registered = true; process.once('exit', () => { for (const base of made.splice(0)) removeTree(base); }); }
  fs.mkdirSync(path.join(root, '.runtime'), { recursive: true });
  const base = fs.mkdtempSync(path.join(root, '.runtime', prefix)); made.push(base); return base;
}

export function removeTree(directory: string): void {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (!entry.isSymbolicLink() && entry.isDirectory()) removeTree(item); else fs.unlinkSync(item);
  }
  fs.rmdirSync(directory);
}
