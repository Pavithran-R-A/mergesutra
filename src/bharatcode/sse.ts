/**
 * Incremental `text/event-stream` framing.
 *
 * The socket decides how the bytes arrive, so this parser cannot: a frame can be split
 * inside a line terminator, inside a multi-byte character (the caller decodes with a
 * streaming `TextDecoder`), or inside the JSON that a data field carries. It therefore
 * consumes text chunks and returns only whole frames.
 *
 * Comments are not data — the provider says queue keepalives are not model output — and a
 * frame is dispatched on the blank line that ends it. A trailing line without a newline is
 * still delivered at end of stream: an answer cut off mid-frame should be refused for what
 * it was, not silently dropped and called "no answer".
 */

export interface SseFrame {
  /** The `event:` field, when the frame carried one. */
  readonly event: string | undefined;
  /** Every `data:` line of the frame, joined with newlines as the format specifies. */
  readonly data: string;
}

interface LineBreak {
  readonly index: number;
  readonly size: number;
}

export class SseParser {
  private buffer = '';
  private searchFrom = 0;
  private eventName: string | undefined;
  private dataLines: string[] = [];
  private first = true;

  /** Feed one decoded chunk, and take back every frame it completed. */
  push(chunk: string): SseFrame[] {
    if (this.first) {
      this.first = false;
      if (chunk.startsWith('\uFEFF')) chunk = chunk.slice(1);
    }
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    for (;;) {
      const lineBreak = this.nextBreak();
      if (!lineBreak) break;
      const line = this.buffer.slice(0, lineBreak.index);
      this.buffer = this.buffer.slice(lineBreak.index + lineBreak.size);
      this.searchFrom = 0;
      this.line(line, frames);
    }
    return frames;
  }

  /** Flush the final, unterminated line and any frame it completes. */
  end(): SseFrame[] {
    const frames: SseFrame[] = [];
    let rest = this.buffer;
    this.buffer = '';
    this.searchFrom = 0;
    if (rest.endsWith('\r')) rest = rest.slice(0, -1);
    if (rest !== '') this.line(rest, frames);
    this.dispatch(frames);
    return frames;
  }

  private nextBreak(): LineBreak | undefined {
    for (let index = this.searchFrom; index < this.buffer.length; index += 1) {
      const character = this.buffer[index];
      if (character === '\n') return { index, size: 1 };
      if (character === '\r') {
        // A CR at the very end may be the first half of CRLF. Waiting for the next chunk
        // is what keeps the LF from being read as a blank line and splitting one frame
        // into two.
        if (index === this.buffer.length - 1) {
          this.searchFrom = index;
          return undefined;
        }
        return { index, size: this.buffer[index + 1] === '\n' ? 2 : 1 };
      }
    }
    this.searchFrom = this.buffer.length;
    return undefined;
  }

  private line(line: string, frames: SseFrame[]): void {
    if (line === '') {
      this.dispatch(frames);
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.eventName = value;
        break;
      case 'data':
        this.dataLines.push(value);
        break;
      default:
        // `id`, `retry` and future fields carry nothing the adapter acts on.
        break;
    }
  }

  private dispatch(frames: SseFrame[]): void {
    const event = this.eventName;
    const data = this.dataLines;
    this.eventName = undefined;
    this.dataLines = [];
    if (data.length === 0) return;
    frames.push({ event: event === '' ? undefined : event, data: data.join('\n') });
  }
}
