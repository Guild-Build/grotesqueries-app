import { utf8Bytes } from '@grotesqueries/protocol';
export type StreamEvent = ({ type: 'output'; sequence: number; data: string } |
  { type: 'grid'; sequence: number; cols: number; rows: number }) & { historyIncomplete?: boolean };
type NewEvent = { type: 'output'; data: string } | { type: 'grid'; cols: number; rows: number };
export class OutputBuffer {
  private events: Array<{ event: StreamEvent; bytes: number }> = [];
  private bytes = 0;
  sequence = 0;
  historyIncomplete = false;
  constructor(private readonly maximumBytes: number) {}
  append(value: NewEvent): StreamEvent {
    const event = { ...value, sequence: ++this.sequence } as StreamEvent;
    const bytes = event.type === 'output' ? utf8Bytes(event.data) : 64;
    this.events.push({ event, bytes }); this.bytes += bytes;
    while (this.bytes > this.maximumBytes) { this.bytes -= this.events.shift()!.bytes; this.historyIncomplete = true; }
    return event;
  }
  since(sequence: number): StreamEvent[] | null {
    if (!this.canResume(sequence)) return null;
    if (sequence === this.sequence) return [];
    if (!this.events.length || sequence < this.events[0].event.sequence - 1) return null;
    return this.events.filter(entry => entry.event.sequence > sequence).map(entry => ({ ...entry.event }));
  }
  next(sequence: number): StreamEvent | null {
    if (!this.canResume(sequence) || sequence === this.sequence) return null;
    const index = sequence - this.events[0].event.sequence + 1;
    return { ...this.events[index].event };
  }
  canResume(sequence: number): boolean {
    return Number.isSafeInteger(sequence) && sequence >= 0 && sequence <= this.sequence &&
      (sequence === this.sequence || (this.events.length > 0 && sequence >= this.events[0].event.sequence - 1));
  }
  get retainedBytes(): number { return this.bytes; }
}
