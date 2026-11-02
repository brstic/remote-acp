/**
 * Spec-compliant incremental parser for `text/event-stream`
 * (https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation).
 *
 * Handles LF, CRLF and lone CR line endings (including a CRLF split across
 * chunks), multi-line `data:`, comments / keep-alives, `id:` persistence,
 * `retry:`, a leading BOM and a single optional space after the colon.
 */

export interface SseMessage {
  /** `event:` field; defaults to `"message"`. */
  event: string;
  /** Joined `data:` lines. */
  data: string;
  /** Last event id in effect when this message was dispatched (may be ""). */
  id: string;
  /** Last `retry:` value seen, in ms. */
  retry?: number;
}

export class SseParser {
  private buf = "";
  private sawCR = false;
  private started = false;
  private data: string[] = [];
  private hasData = false;
  private eventType = "";
  private lastId = "";
  private retry: number | undefined;

  /** Feed decoded text; returns the messages completed by this chunk. */
  feed(chunk: string): SseMessage[] {
    const out: SseMessage[] = [];
    let text = chunk;
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (this.sawCR) {
        this.sawCR = false;
        if (ch === "\n") continue; // CRLF: the CR already ended the line.
      }
      if (ch === "\r" || ch === "\n") {
        if (ch === "\r") this.sawCR = true;
        const msg = this.line(this.buf);
        this.buf = "";
        if (msg) out.push(msg);
      } else {
        this.buf += ch;
      }
    }
    return out;
  }

  /** Discard any partially received message (call when the connection drops). */
  reset(): void {
    this.buf = "";
    this.sawCR = false;
    this.data = [];
    this.hasData = false;
    this.eventType = "";
  }

  private line(line: string): SseMessage | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null; // comment / keep-alive
    const colon = line.indexOf(":");
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    switch (field) {
      case "event":
        this.eventType = value;
        break;
      case "data":
        this.data.push(value);
        this.hasData = true;
        break;
      case "id":
        if (!value.includes("\0")) this.lastId = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.retry = Number(value);
        break;
      default:
        break; // ignore unknown fields
    }
    return null;
  }

  private dispatch(): SseMessage | null {
    const hasData = this.hasData;
    const msg: SseMessage = {
      event: this.eventType || "message",
      data: this.data.join("\n"),
      id: this.lastId,
      ...(this.retry !== undefined ? { retry: this.retry } : {}),
    };
    this.data = [];
    this.hasData = false;
    this.eventType = "";
    return hasData ? msg : null;
  }
}

/** Parse a byte stream (e.g. `response.body`) into SSE messages. */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<SseMessage, void, undefined> {
  const parser = new SseParser();
  const decoder = new TextDecoder("utf-8");
  const iterable: AsyncIterable<Uint8Array> =
    Symbol.asyncIterator in body ? (body as AsyncIterable<Uint8Array>) : readerIterable(body as ReadableStream<Uint8Array>);
  for await (const chunk of iterable) {
    for (const m of parser.feed(decoder.decode(chunk, { stream: true }))) yield m;
  }
  for (const m of parser.feed(decoder.decode())) yield m;
  // Per spec, an incomplete trailing message (no blank line) is discarded.
}

async function* readerIterable(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      if (value) yield value;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
