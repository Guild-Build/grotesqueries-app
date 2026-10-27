/** Frames with the pinned parser's actual immutable VT500 transition table.
 * The special ESC transition after OSC/DCS end matches EscapeSequenceParser.
 */
export class TerminalStream {
  private pending = ''; private state = 0; private scanned = 0;
  constructor(private readonly maximumBytes: number, private readonly transitions: Uint8Array) {}
  push(data: string): string {
    const text = this.pending + data; let boundary = 0;
    for (let i = this.scanned; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i === text.length - 1) break;
      const transition = this.transitions[(this.state << 8) | (code < 0xa0 ? code : 0xa0)];
      const action = transition >> 4;
      this.state = transition & 15;
      // OSC_END=6 and DCS_UNHOOK=14 receive ESC then continue in ESCAPE=1.
      if (code === 0x1b && (action === 6 || action === 14)) this.state = 1;
      this.scanned = i + 1;
      if (this.state === 0) boundary = i + 1;
    }
    this.pending = text.slice(boundary); this.scanned -= boundary;
    if (new TextEncoder().encode(this.pending).byteLength > this.maximumBytes) throw new Error('INCOMPLETE_SEQUENCE_LIMIT');
    return text.slice(0, boundary);
  }
  get incomplete(): boolean { return this.pending.length > 0; }
}
