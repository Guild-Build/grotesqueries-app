import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { ViewMode } from '@grotesqueries/protocol';
import { installSnapshotState } from '@grotesqueries/protocol';
import { installRendererReplySuppression } from './replies.js';
import { TERMINAL_PALETTE } from './palette.js';

/** Browser renderer only. Process lifetime and transport are external. */
export class TerminalView {
  private readonly terminal: Terminal;
  private readonly fitAddon = new FitAddon();
  private readonly observer: ResizeObserver;
  private readonly hooks: Array<() => void> = [];
  private readonly snapshotState: ReturnType<typeof installSnapshotState>;
  private mode: ViewMode = 'observing'; private hostGrid = false; private restoring = false;
  constructor(container: HTMLElement, private readonly options: { cols: number; rows: number; scrollback: number; fixedCols?: number;
    onInput: (data: string) => void; onResize: (cols: number, rows: number) => void; problem: (message: string) => void }) {
    this.terminal = new Terminal({ cols: options.cols, rows: options.rows, theme: TERMINAL_PALETTE,
      fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 14, scrollback: options.scrollback,
      disableStdin: true, allowProposedApi: true, screenReaderMode: false, logLevel: 'off',
      windowOptions: { getWinSizeChars: true, pushTitle: true, popTitle: true } });
    this.terminal.loadAddon(new Unicode11Addon()); this.terminal.unicode.activeVersion = '11';
    this.hooks.push(installRendererReplySuppression(this.terminal));
    this.snapshotState = installSnapshotState(this.terminal, () => this.restoring); this.hooks.push(this.snapshotState);
    this.terminal.loadAddon(this.fitAddon); this.terminal.open(container);
    try { const renderer = new WebglAddon(); renderer.onContextLoss(() => renderer.dispose()); this.terminal.loadAddon(renderer); }
    catch { /* Standard xterm renderer remains usable. */ }
    const input = this.terminal.onData(data => { if (this.mode === 'controlling' && !this.restoring) options.onInput(data); });
    const binary = this.terminal.onBinary(data => { if (this.mode === 'controlling' && !this.restoring) options.onInput(data); });
    const resize = this.terminal.onResize(({ cols, rows }) => { if (this.mode === 'controlling' && !this.hostGrid) options.onResize(cols, rows); });
    this.hooks.push(() => { input.dispose(); binary.dispose(); resize.dispose(); });
    this.terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown') return true;
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyC') { event.preventDefault(); void this.copy().catch(() => options.problem('Clipboard copy failed. Select text and use the browser copy command.')); return false; }
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyV') { event.preventDefault(); void this.paste().catch(() => options.problem('Clipboard paste permission is unavailable. Use the browser paste command.')); return false; }
      return true; // Plain Ctrl+C remains the native interrupt character.
    });
    this.observer = new ResizeObserver(() => { if (this.mode === 'controlling' && !this.restoring) this.fit(); }); this.observer.observe(container);
  }
  setMode(mode: ViewMode): void {
    const changed = this.mode !== mode; this.mode = mode;
    this.terminal.options.disableStdin = mode !== 'controlling' || this.restoring;
    if (changed && mode === 'controlling' && !this.restoring) this.fit();
  }
  private fit(): void {
    const grid = this.fitAddon.proposeDimensions(); if (!grid) return;
    const cols = this.options.fixedCols ?? Math.min(300, Math.max(2, grid.cols)); const rows = Math.min(200, Math.max(1, grid.rows));
    if (cols !== this.terminal.cols || rows !== this.terminal.rows) this.terminal.resize(cols, rows);
  }
  setGrid(cols: number, rows: number): void { this.hostGrid = true; try { this.terminal.resize(cols, rows); } finally { this.hostGrid = false; } }
  setAccessibility(enabled: boolean): void { this.terminal.options.screenReaderMode = enabled; }
  write(data: string): Promise<void> { return new Promise(resolve => this.terminal.write(data, resolve)); }
  beginRestore(): void { this.restoring = true; this.setMode('observing'); }
  completeRestore(): void { this.snapshotState.complete(); this.restoring = false; }
  async copy(): Promise<void> { const text = this.terminal.getSelection(); if (text) await navigator.clipboard.writeText(text); }
  async paste(): Promise<void> { if (this.mode !== 'controlling' || this.restoring) return; const text = await navigator.clipboard.readText(); this.terminal.paste(text); this.terminal.focus(); }
  focus(): void { this.terminal.focus(); }
  dispose(): void { this.observer.disconnect(); this.hooks.forEach(hook => hook()); this.terminal.dispose(); }
}
