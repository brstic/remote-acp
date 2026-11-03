// Tiny HTTP client for driving an example website's own API from E2E tests:
// keeps the session cookie, sends a same-origin `Origin` header on writes and
// reads the website's SSE endpoints (EventSource wire format).
import { parseSseStream } from "@remote-acp/web-sdk";

export interface SseMessage {
  id: string;
  event: string;
  data: any;
}

export class AppClient {
  cookie = "";

  constructor(readonly base: string) {}

  async call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
    const r = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(method !== "GET" ? { origin: this.base } : {}),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const set = r.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0]!.endsWith("=") ? "" : set.split(";")[0]!;
    const text = await r.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, body, headers: r.headers };
  }

  post(path: string, body: unknown = {}) {
    return this.call(path, { method: "POST", body });
  }

  /**
   * Read an SSE endpoint until an event named in `stopOn` (default `end`) or
   * until `onEvent` returns `"stop"`. Returns every message.
   */
  async sse(
    path: string,
    opts: { lastEventId?: number; stopOn?: string[]; onEvent?: (m: SseMessage) => unknown; timeoutMs?: number } = {},
  ): Promise<SseMessage[]> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`SSE ${path} timed out`)), opts.timeoutMs ?? 30_000);
    const r = await fetch(`${this.base}${path}`, {
      headers: {
        accept: "text/event-stream",
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(opts.lastEventId !== undefined ? { "last-event-id": String(opts.lastEventId) } : {}),
      },
      signal: ac.signal,
    });
    if (r.status !== 200) {
      clearTimeout(timer);
      throw new Error(`SSE ${path} -> HTTP ${r.status}: ${await r.text()}`);
    }
    const stopOn = new Set(opts.stopOn ?? ["end"]);
    const out: SseMessage[] = [];
    try {
      for await (const m of parseSseStream(r.body!)) {
        let data: any = m.data;
        try {
          data = JSON.parse(m.data);
        } catch {
          /* keep raw */
        }
        const msg = { id: m.id, event: m.event, data };
        out.push(msg);
        if ((await opts.onEvent?.(msg)) === "stop" || stopOn.has(m.event)) break;
      }
    } finally {
      clearTimeout(timer);
      ac.abort();
    }
    return out;
  }
}

/** Concatenated `text_delta` text of relay task events re-streamed by a website. */
export function streamedText(msgs: SseMessage[]): string {
  return msgs
    .filter((m) => m.event === "task.event" && m.data?.payload?.type === "text_delta")
    .map((m) => m.data.payload.text as string)
    .join("");
}

export async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 10_000, everyMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`condition not met in ${timeoutMs}ms; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
