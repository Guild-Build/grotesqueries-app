/** C-07 and A-05: a plugin's own files import only this contract or files inside the plugin folder. */
const contract = '@grotesqueries/protocol';
const modules = /(?<![\w$.])(?:from\s*|import\s*\(?\s*|require\s*\(\s*|(?:Shared)?Worker\s*\(\s*|importScripts\s*\(\s*)(['"`])([^'"`\r\n]+)\1/g;

function specifiers(source: string): string[] { return [...source.matchAll(modules)].map(match => match[2]); }
function inside(file: string, specifier: string): boolean {
  if (!/^\.\.?[\\/]/.test(specifier)) return false;
  const folder = file.split('/').slice(0, -1);
  for (const segment of specifier.replace(/[?#].*$/, '').split(/[\\/]/)) {
    if (segment === '..') { if (folder.pop() === undefined) return false; }
    else if (segment && segment !== '.') folder.push(segment);
  }
  return true;
}

// Single-file components hold their scripts in <script> blocks, as a page does.
const scripts = /\.[cm]?[jt]sx?$/i, pages = /\.(?:html?|vue|svelte)$/i;
/** Whether `importViolations` reads this file at all; other files can import nothing. */
export function importChecked(file: string): boolean { return scripts.test(file) || pages.test(file); }

/**
 * Refused specifiers in one plugin file. `file` is its '/'-separated path inside the plugin folder.
 * Scripts are checked for import, export-from, dynamic import, require, Worker, SharedWorker and importScripts;
 * HTML, Vue and Svelte files for script sources and bodies, and an import map is refused outright.
 * The check is lexical and conservative: a quoted string after `from` in a script counts as an import.
 */
export function importViolations(file: string, source: string): string[] {
  const found: string[] = [];
  if (scripts.test(file)) found.push(...specifiers(source));
  else if (pages.test(file)) {
    for (const [, attributes, body] of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      const src = /(?<![\w-])src\s*=\s*(['"]?)([^'"\s>]+)\1/i.exec(attributes);
      if (src) found.push(src[2]);
      // An import map can point the contract's own name anywhere, so a plugin may not declare one.
      if (/(?<![\w-])type\s*=\s*(['"]?)importmap\1/i.test(attributes)) found.push('<script type="importmap">');
      found.push(...specifiers(body));
    }
  }
  return found.filter(specifier => specifier !== contract && !inside(file, specifier));
}
