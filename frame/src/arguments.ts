/** Windows argument quoting, not a shell: quotes group spaces, backslashes escape only before quotes. */
export function formatArguments(args: readonly string[]): string {
  return args.map(arg => arg && !/[\s"]/.test(arg) ? arg : '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"').join(' ');
}
export function parseArguments(text: string): string[] {
  const result: string[] = []; let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i === text.length) break;
    let arg = '', quoted = false;
    while (i < text.length && (quoted || !/\s/.test(text[i]))) {
      if (text[i] === '\\') {
        let count = 0; while (text[i] === '\\') { count++; i++; }
        if (text[i] === '"') { arg += '\\'.repeat(Math.floor(count / 2)); if (count % 2) arg += '"'; else quoted = !quoted; i++; }
        else arg += '\\'.repeat(count);
      } else if (text[i] === '"') { quoted = !quoted; i++; }
      else arg += text[i++];
    }
    if (quoted) throw new Error('Arguments contain an unclosed double quote.');
    result.push(arg);
  }
  return result;
}
