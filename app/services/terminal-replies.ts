import { utf8Bytes } from '@grotesqueries/protocol';
import type { Terminal } from '@xterm/headless';
import { createHash } from 'node:crypto';

const base = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];
function initialPalette(): string[] {
  return Array.from({ length: 256 }, (_, i) => {
    if (i < 16) return base[i];
    const values = i < 232 ? [Math.floor((i - 16) / 36), Math.floor((i - 16) / 6) % 6, (i - 16) % 6].map(x => x ? 55 + 40 * x : 0)
      : [8 + 10 * (i - 232), 8 + 10 * (i - 232), 8 + 10 * (i - 232)];
    return '#' + values.map(x => x.toString(16).padStart(2, '0')).join('');
  });
}
function color(spec: string): string | null {
  if (/^#[\da-f]{6}$/i.test(spec)) return spec.toLowerCase();
  if (/^#[\da-f]{3}$/i.test(spec)) return '#' + spec.slice(1).split('').map(c => c + c).join('').toLowerCase();
  const rgb = /^rgb:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})$/i.exec(spec);
  return rgb ? '#' + rgb.slice(1).map(x => Math.round(parseInt(x, 16) * 255 / (16 ** x.length - 1)).toString(16).padStart(2, '0')).join('') : null;
}
function report(spec: string): string { return 'rgb:' + [1, 3, 5].map(i => spec.slice(i, i + 2).repeat(2)).join('/'); }
export class TerminalReplyBridge {
  private origin: 'live-pty' | 'replay' = 'replay';
  private replies: string[] = []; private bytes = 0; private failure = false;
  private sentCount = 0; private readonly sentHash = createHash('sha256');
  private readonly palette = initialPalette();
  private readonly special = ['#d4d4d4', '#1e1e1e', '#ffffff'];
  private readonly hooks: Array<{ dispose(): void }>;
  constructor(terminal: Terminal, private readonly send?: (data: string) => void,
    private readonly running: () => boolean = () => false) {
    this.hooks = [terminal.onData(data => this.collect(data)),
      terminal.parser.registerOscHandler(4, data => {
        const parts = data.split(';');
        for (let i = 0; i + 1 < parts.length; i += 2) {
          if (!/^\d+$/.test(parts[i])) continue; const index = Number(parts[i]); if (index > 255) continue;
          if (parts[i + 1] === '?') this.collect(`\x1b]4;${index};${report(this.palette[index])}\x1b\\`);
          else { const value = color(parts[i + 1]); if (value) this.palette[index] = value; }
        }
        return true;
      }),
      ...[10, 11, 12].map(id => terminal.parser.registerOscHandler(id, data => {
        data.split(';').forEach((part, offset) => {
          const slot = id + offset - 10; if (slot > 2) return;
          if (part === '?') this.collect(`\x1b]${slot + 10};${report(this.special[slot])}\x1b\\`);
          else { const value = color(part); if (value) this.special[slot] = value; }
        }); return true;
      })),
      terminal.parser.registerOscHandler(104, data => { const defaults = initialPalette();
        if (!data) this.palette.splice(0, 256, ...defaults);
        else for (const value of data.split(';')) if (/^\d+$/.test(value) && Number(value) < 256) this.palette[Number(value)] = defaults[Number(value)];
        return true;
      }),
      ...[110, 111, 112].map(id => terminal.parser.registerOscHandler(id, () => { this.special[id - 110] = ['#d4d4d4', '#1e1e1e', '#ffffff'][id - 110]; return true; })),
    ];
  }
  begin(origin: 'live-pty' | 'replay'): void { this.origin = origin; this.replies = []; this.bytes = 0; this.failure = false; }
  private collect(data: string): void {
    if (this.origin !== 'live-pty') return;
    const bytes = utf8Bytes(data); if (bytes > 4096 || this.bytes + bytes > 65536) { this.failure = true; return; }
    this.bytes += bytes; this.replies.push(data);
  }
  flush(): void {
    this.origin = 'replay';
    if (this.failure) throw new Error('TERMINAL_REPLY_OVERFLOW');
    if (this.running() && this.send) for (const reply of this.replies) {
      this.send(reply); this.sentCount++; this.sentHash.update(reply);
    }
    this.replies = [];
  }
  accounting(): { count: number; sha256: string } { return { count: this.sentCount, sha256: this.sentHash.copy().digest('hex') }; }
  serializeColors(): string {
    return '\x1b]4;' + this.palette.map((value, i) => `${i};${value}`).join(';') + '\x1b\\' +
      this.special.map((value, i) => `\x1b]${i + 10};${value}\x1b\\`).join('');
  }
  dispose(): void { this.hooks.forEach(hook => hook.dispose()); }
}
