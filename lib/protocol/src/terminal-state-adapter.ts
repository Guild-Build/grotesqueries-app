/** Pinned xterm 5.5.0 supplemental state; xterm.js authors, MIT.
 * SerializeAddon does not preserve saved cursors, margins, tabs or charset state.
 * This adapter is shared by host tests and browser snapshot restoration only.
 */
export interface ParserTerminal {
  parser: {
    registerOscHandler(id: number, handler: (data: string) => boolean): { dispose(): void };
    registerCsiHandler(id: { prefix?: string; intermediates?: string; final: string }, handler: (params: (number | number[])[]) => boolean): { dispose(): void };
    registerDcsHandler(id: { prefix?: string; intermediates?: string; final: string }, handler: (data: string, params: (number | number[])[]) => boolean): { dispose(): void };
  };
}
// Private access is confined here and the mixed-color adapter, with differential gates.
export function pinnedCore(terminal: ParserTerminal): any { return (terminal as any)._core; }
const bufferFields = ['x', 'y', 'savedX', 'savedY', 'scrollTop', 'scrollBottom', 'tabs', 'savedCharset'] as const;
const inputFields = ['_windowTitle', '_iconName', '_windowTitleStack', '_iconNameStack'] as const;
function attributes(value: any) { return { fg: value.fg, bg: value.bg, ext: value.extended._ext, urlId: value.extended._urlId }; }
function setAttributes(target: any, value: any): void {
  target.fg = value.fg; target.bg = value.bg; target.extended._ext = value.ext; target.extended._urlId = value.urlId;
}
function stateCommand(id: number, value: unknown): string { return `\x1b]${id};${encodeURIComponent(JSON.stringify(value))}\x1b\\`; }
function serializeCellAttributes(core: any): string {
  let result = ''; const markerLocations = new Map<any, [number, number]>();
  ['normal', 'alt'].forEach((name, bufferIndex) => {
    const buffer = core._bufferService.buffers[name];
    for (const marker of buffer.markers) markerLocations.set(marker, [bufferIndex, marker.line]);
    let group: { y: number; n: number; key: string; wrapped: boolean; runs: number[][]; ext: number[][] } | undefined;
    const flush = () => {
      if (group) result += stateCommand(778, { b: bufferIndex, y: group.y, n: group.n, wrapped: group.wrapped, runs: group.runs, ext: group.ext });
    };
    for (let y = 0; y < buffer.lines.length; y++) {
      const line = buffer.lines.get(y); const runs: number[][] = [];
      for (let start = 0; start < line.length;) {
        const fg = line._data[start * 3 + 1]; const bg = line._data[start * 3 + 2]; let end = start + 1;
        while (end < line.length && line._data[end * 3 + 1] === fg && line._data[end * 3 + 2] === bg) end++;
        runs.push([start, end, fg, bg]); start = end;
      }
      const ext = Object.entries(line._extendedAttrs).filter(([, value]) => value).map(([x, value]) => {
        const attr = value as any; return [Number(x), attr._ext, attr._urlId];
      });
      const key = JSON.stringify([line.isWrapped, runs, ext]);
      if (group?.key === key) group.n++;
      else { flush(); group = { y, n: 1, key, wrapped: line.isWrapped, runs, ext }; }
    }
    flush();
  });
  for (const entry of core._oscLinkService._dataByLinkId.values()) {
    const lines = entry.lines.map((marker: any) => markerLocations.get(marker)).filter(Boolean);
    result += stateCommand(779, { id: entry.id, data: entry.data, lines });
  }
  return result;
}
export function serializeSupplement(terminal: ParserTerminal): string {
  const core = pinnedCore(terminal); const handler = core._inputHandler;
  const buffers = ['normal', 'alt'].map(name => {
    const buffer = core._bufferService.buffers[name]; const state: any = {};
    for (const field of bufferFields) state[field] = buffer[field];
    state.savedAttr = attributes(buffer.savedCurAttrData); return state;
  });
  const input: any = {}; for (const field of inputFields) input[field] = handler[field];
  const value = { v: 1, buffers, input, attr: attributes(handler._curAttrData), eraseAttr: attributes(handler._eraseAttrDataInternal),
    charset: { charset: core._charsetService.charset, glevel: core._charsetService.glevel, charsets: core._charsetService._charsets },
    join: handler._parser.precedingJoinState,
    style: { cursorStyle: core.optionsService.rawOptions.cursorStyle, cursorBlink: core.optionsService.rawOptions.cursorBlink,
      convertEol: core.optionsService.rawOptions.convertEol },
    cursor: { hidden: core.coreService.isCursorHidden, initialized: core.coreService.isCursorInitialized },
    mouse: { protocol: core.coreMouseService.activeProtocol, encoding: core.coreMouseService.activeEncoding } };
  return serializeCellAttributes(core) + stateCommand(777, value);
}
export function installSnapshotState(terminal: ParserTerminal, restoring: () => boolean): (() => void) & { complete(): void } {
  let finalState: any;
  let failure = false;
  const guarded = (action: (value: any) => void) => (data: string) => {
    if (!restoring()) return true;
    try { action(JSON.parse(decodeURIComponent(data))); } catch { failure = true; }
    return true;
  };
  const hooks = [terminal.parser.registerOscHandler(778, guarded(value => {
    const core = pinnedCore(terminal); const buffer = core._bufferService.buffers[value.b === 0 ? 'normal' : 'alt'];
    const count = value.n ?? 1;
    if (!Number.isSafeInteger(value.y) || !Number.isSafeInteger(count) || value.y < 0 || count < 1 || value.y + count > buffer.lines.length) throw new Error('INVALID_SNAPSHOT_LINE');
    const Extended = core._inputHandler._curAttrData.extended.constructor;
    for (let y = value.y; y < value.y + count; y++) {
      const line = buffer.lines.get(y); line.isWrapped = value.wrapped; line._extendedAttrs = {};
      for (const [start, end, fg, bg] of value.runs) for (let x = start; x < end; x++) { line._data[x * 3 + 1] = fg; line._data[x * 3 + 2] = bg; }
      for (const [x, ext, urlId] of value.ext) { const attr = new Extended(); attr._ext = ext; attr._urlId = urlId; line._extendedAttrs[x] = attr; }
    }
  })), terminal.parser.registerOscHandler(779, guarded(value => {
    const core = pinnedCore(terminal); const service = core._oscLinkService;
    const entry: any = { id: value.id, data: { id: value.data.id, uri: value.data.uri }, lines: [] };
    if (value.data.id !== undefined) { entry.key = `${value.data.id};;${value.data.uri}`; service._entriesWithId.set(entry.key, entry); }
    service._dataByLinkId.set(entry.id, entry); service._nextId = Math.max(service._nextId, entry.id + 1);
    for (const [b, y] of value.lines) {
      const marker = core._bufferService.buffers[b === 0 ? 'normal' : 'alt'].addMarker(y);
      entry.lines.push(marker); marker.onDispose(() => service._removeMarkerFromLink(entry, marker));
    }
  })), terminal.parser.registerOscHandler(777, guarded(value => {
    if (!restoring()) return true;
    if (value.v !== 1 || !Array.isArray(value.buffers) || value.buffers.length !== 2) throw new Error('INVALID_SNAPSHOT_STATE');
    const core = pinnedCore(terminal); const handler = core._inputHandler;
    finalState = value;
    ['normal', 'alt'].forEach((name, index) => {
      const buffer = core._bufferService.buffers[name]; const state = value.buffers[index];
      for (const field of bufferFields) buffer[field] = state[field];
      setAttributes(buffer.savedCurAttrData, state.savedAttr);
    });
    for (const field of inputFields) handler[field] = value.input[field];
    setAttributes(handler._curAttrData, value.attr); setAttributes(handler._eraseAttrDataInternal, value.eraseAttr);
    core._charsetService.charset = value.charset.charset; core._charsetService.glevel = value.charset.glevel;
    core._charsetService._charsets = value.charset.charsets;
    core.coreService.isCursorHidden = value.cursor.hidden; core.coreService.isCursorInitialized = value.cursor.initialized;
    core.coreMouseService.activeProtocol = value.mouse.protocol; core.coreMouseService.activeEncoding = value.mouse.encoding;
  }))];
  const dispose = () => hooks.forEach(hook => hook.dispose());
  dispose.complete = () => {
    if (failure || !finalState) throw new Error('INVALID_SNAPSHOT_STATE');
    const core = pinnedCore(terminal);
    core._inputHandler._parser.precedingJoinState = finalState.join;
    core.optionsService.options.cursorStyle = finalState.style.cursorStyle;
    core.optionsService.options.cursorBlink = finalState.style.cursorBlink;
    core.optionsService.options.convertEol = finalState.style.convertEol;
    (terminal as any).refresh?.(0, core._bufferService.rows - 1);
    finalState = undefined;
  };
  return dispose;
}
