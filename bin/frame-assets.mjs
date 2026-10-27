// Adapted from Grotesqueries' reviewed helper at 792e0ee2641525c61e496f863b634976e8f0b419.
import fs from 'node:fs';
import path from 'node:path';

export const FRAME_FILES = ['index.html', 'assets/app.js', 'assets/app.css', 'assets/licenses.txt'];

/** Embed the complete built frame. Missing files and symlinks fail before packaging. */
export function frameAssets(folder) {
  if (!folder) throw new Error('WINDOWS_FRAME_REQUIRED');
  folder = path.resolve(folder);
  if (!fs.lstatSync(folder).isDirectory() || fs.lstatSync(folder).isSymbolicLink()) throw new Error('WINDOWS_FRAME_INVALID');
  return Object.fromEntries(FRAME_FILES.map(name => {
    let file = folder;
    for (const part of name.split('/')) {
      file = path.join(file, part);
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('WINDOWS_FRAME_SYMLINK');
    }
    if (!fs.statSync(file).isFile()) throw new Error('WINDOWS_FRAME_MISSING: ' + name);
    return ['web/frame/' + name, file];
  }));
}
