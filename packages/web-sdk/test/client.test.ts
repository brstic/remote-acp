import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteAcp, RemoteAcpError, type FetchLike, type StreamItem } from "../src/index.js";

const SECRET = "test-secret-0123456789abcdef";

interface Call {
  url: string;
  init: RequestInit | undefined;
  headers: Record<string, string>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** An SSE response whose body emits `parts` then closes (or errors with `fail`). */
function sse(parts: string[], end: "close" | "error" | "hang" = "close"): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      const p = parts.shift();
      if (p !== undefined) {
        c.enqueue(enc.encode(p));
        return;
      }
      if (end === "close") c.close();
      else if (end === "error") c.error(new TypeError("terminated"));
      else await new Promise(() => undefined);
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function ev(seq: number, kind: string, payload: unknown): string {
  return `id: ${seq}\nevent: ${kind}\ndata: ${JSON.stringify({ seq, kind, payload })}\n\n`;
}

function mockFetch(handler: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const call = { url, init, headers };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fn, calls };
}

function client(fetch: FetchLike, relayUrl = "https://relay.example.com/") {
  return new RemoteAcp({ serviceId: "svc_demo", serviceSecret: SECRET, relayUrl, fetch });
}

async function collect(it: AsyncIterable<StreamItem>): Promise<StreamItem[]> {
  const out: StreamItem[] = [];
  for await (const e of it) out.push(e);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("constructor safety", () => {
  it("refuses non-https relay URLs except localhost", () => {
    const f = mockFetch(() => json(200, {})).fn;
    expect(() => client(f, "http://relay.example.com")).toThrowError(/https/);
    expect(() => client(f, "ftp://localhost")).toThrowError(RemoteAcpError);
    expect(() => client(f, "http://localhost:8787")).not.toThrow();
    expect(() => client(f, "http://127.0.0.1:8787")).not.toThrow();
    expect(() => client(f, "http://[::1]:8787")).not.toThrow();
    expect(() => client(f, "not a url")).toThrowError(/valid URL/);
  });

  it("throws when instantiated in a browser", () => {
    vi.stubGlobal("window", {});
    expect(() => client(mockFetch(() => json(200, {})).fn)).toThrowError(/server-side only/);
  });

  it("does not expose the secret via JSON", () => {
    const c = client(mockFetch(() => json(200, {})).fn);
    expect(JSON.stringify(c)).not.toContain(SECRET);
  });
});

describe("REST calls", () => {
  it("sends the service bearer credential and JSON body", async () => {
    const { fn, calls } = mockFetch(() =>
      json(200, { pairingId: "pair_1", url: "remoteacp://pair?ticket=t", code: "ABCDE-12345", expiresAt: "2026-11-02T19:02:00Z" }),
    );
    const p = await client(fn).createPairing({ externalUserId: "u1", scopes: ["task.interactive"], expiresInSeconds: 120 });
    expect(p.pairingId).toBe("pair_1");
    expect(calls[0]!.url).toBe("https://relay.example.com/v1/pairings");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.headers.authorization).toBe(`Bearer svc_demo.${SECRET}`);
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ externalUserId: "u1", scopes: ["task.interactive"], expiresInSeconds: 120 });
  });

  it("encodes path and query parameters", async () => {
    const { fn, calls } = mockFetch(() => json(200, { connections: [] }));
    await client(fn).listConnections("user/with space&x");
    expect(calls[0]!.url).toBe("https://relay.example.com/v1/connections?externalUserId=user%2Fwith%20space%26x");
    await client(fn).getTask("../x").catch(() => undefined);
    expect(calls[1]!.url).toBe("https://relay.example.com/v1/tasks/..%2Fx");
  });

  it("maps relay error bodies to RemoteAcpError", async () => {
    const { fn } = mockFetch(() => json(409, { error: { code: "desktop_offline", message: "The desktop app is not connected" } }));
    const err = await client(fn)
      .startTask({ connectionId: "conn_1", externalUserId: "u", prompt: "hi", idempotencyKey: "k" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteAcpError);
    expect(err).toMatchObject({ code: "desktop_offline", status: 409, message: "The desktop app is not connected" });
  });

  it("maps non-JSON errors and network errors", async () => {
    const e1 = await client(mockFetch(() => new Response("bad gateway", { status: 502 })).fn).getTask("t").catch((e: unknown) => e);
    expect(e1).toMatchObject({ code: "http_502", status: 502 });
    const e2 = await client(
      mockFetch(() => {
        throw new TypeError("fetch failed");
      }).fn,
    )
      .getTask("t")
      .catch((e: unknown) => e);
    expect(e2).toMatchObject({ code: "network_error", status: 0 });
  });

  it("generates an idempotency key when omitted", async () => {
    const { fn, calls } = mockFetch(() => json(201, { taskId: "task_1", state: "pending" }));
    await client(fn).startTask({ connectionId: "conn_1", externalUserId: "u", prompt: "hi" });
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sends website instructions and tools only when given", async () => {
    const { fn, calls } = mockFetch(() => json(201, { taskId: "task_1", state: "pending" }));
    await client(fn).startTask({
      connectionId: "conn_1",
      externalUserId: "u",
      prompt: "hi",
      instructions: "You are the Acme assistant.",
      tools: [{ name: "acme", url: "https://acme.example/mcp", headers: [{ name: "Authorization", value: "Bearer t" }] }],
    });
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.instructions).toBe("You are the Acme assistant.");
    expect(body.tools).toEqual([{ name: "acme", url: "https://acme.example/mcp", headers: [{ name: "Authorization", value: "Bearer t" }] }]);
    await client(fn).startTask({ connectionId: "conn_1", externalUserId: "u", prompt: "hi" });
    const body2 = JSON.parse(calls[1]!.init!.body as string);
    expect("instructions" in body2).toBe(false);
    expect("tools" in body2).toBe(false);
  });

  it("waitForPairing polls until a final status", async () => {
    const statuses = ["pending", "claimed", "accepted"];
    const { fn, calls } = mockFetch(() =>
      json(200, {
        pairingId: "pair_1",
        status: statuses.shift(),
        connectionId: statuses.length === 0 ? "conn_1" : null,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const p = await client(fn).waitForPairing("pair_1", { intervalMs: 50 });
    expect(p).toMatchObject({ status: "accepted", connectionId: "conn_1" });
    expect(calls).toHaveLength(3);
  });

  it("waitForPairing honours timeout and abort", async () => {
    const pending = () => json(200, { pairingId: "p", status: "pending", connectionId: null, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const c = client(mockFetch(pending).fn);
    await expect(c.waitForPairing("p", { intervalMs: 50, timeoutMs: 120 })).rejects.toMatchObject({ code: "timeout" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    await expect(c.waitForPairing("p", { intervalMs: 50, signal: ac.signal })).rejects.toMatchObject({ code: "aborted" });
  });
});

describe("streamEvents", () => {
  it("yields events until the terminal event, ignoring keep-alives", async () => {
    const { fn, calls } = mockFetch(() =>
      sse([
        ": keep-alive\n\n",
        ev(1, "task.accepted", {}),
        ev(2, "task.event", { type: "text_delta", text: "Hel" }),
        ev(3, "task.event", { type: "text_delta", text: "lo" }),
        ev(4, "task.completed", { stopReason: "end_turn" }),
        ev(5, "task.event", { type: "text_delta", text: "never" }),
      ], "hang"),
    );
    const out = await collect(client(fn).streamEvents("task_1"));
    expect(out.map((e) => e.kind)).toEqual(["task.accepted", "task.event", "task.event", "task.completed"]);
    expect(calls[0]!.headers.accept).toBe("text/event-stream");
    expect(calls[0]!.headers["last-event-id"]).toBeUndefined();
  });

  it("sends Last-Event-ID when resuming explicitly", async () => {
    const { fn, calls } = mockFetch(() => sse([ev(8, "task.completed", { stopReason: "end_turn" })]));
    await collect(client(fn).streamEvents("task_1", { lastEventId: 7 }));
    expect(calls[0]!.headers["last-event-id"]).toBe("7");
  });

  it("automatically resumes with Last-Event-ID after a network drop and de-duplicates", async () => {
    const { fn, calls } = mockFetch((_c, n) => {
      if (n === 0) return sse([ev(1, "task.accepted", {}), ev(2, "task.event", { type: "text_delta", text: "a" }), 'id: 3\nevent: task.ev'], "error");
      // Relay replays from seq 3; include a duplicate 2 to check dedupe.
      return sse([ev(2, "task.event", { type: "text_delta", text: "a" }), ev(3, "task.event", { type: "text_delta", text: "b" }), ev(4, "task.completed", { stopReason: "end_turn" })]);
    });
    const out = await collect(client(fn).streamEvents("task_1", { retryDelayMs: 1 }));
    expect(out.map((e) => ("seq" in e ? e.seq : -1))).toEqual([1, 2, 3, 4]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers["last-event-id"]).toBe("2");
  });

  it("resumes when the stream ends early (EOF) without a terminal event", async () => {
    const { fn, calls } = mockFetch((c, n) => {
      if (c.url.endsWith("/events")) {
        if (n === 0) return sse([ev(1, "task.accepted", {})]);
        return sse([ev(2, "task.failed", { code: "desktop_offline", message: "gone" })]);
      }
      return json(200, { taskId: "task_1", state: "running" });
    });
    const out = await collect(client(fn).streamEvents("task_1", { retryDelayMs: 1 }));
    expect(out.at(-1)).toMatchObject({ kind: "task.failed", payload: { code: "desktop_offline" } });
    expect(calls.at(-1)!.headers["last-event-id"]).toBe("1");
  });

  it("resumes after a relay `lagged` error event", async () => {
    const { fn, calls } = mockFetch((_c, n) =>
      n === 0
        ? sse([ev(1, "task.accepted", {}), `event: error\ndata: {"code":"lagged","message":"Reconnect"}\n\n`])
        : sse([ev(2, "task.completed", { stopReason: "end_turn" })]),
    );
    const out = await collect(client(fn).streamEvents("task_1", { retryDelayMs: 1 }));
    expect(out.map((e) => e.kind)).toEqual(["task.accepted", "task.completed"]);
    expect(calls[1]!.headers["last-event-id"]).toBe("1");
  });

  it("surfaces resume_unavailable as an error item and keeps streaming", async () => {
    const { fn } = mockFetch(() =>
      sse([`event: error\ndata: {"code":"resume_unavailable","message":"Some earlier events are no longer available"}\n\n`, ev(900, "task.completed", { stopReason: "end_turn" })]),
    );
    const out = await collect(client(fn).streamEvents("task_1", { lastEventId: 1 }));
    expect(out[0]).toEqual({ kind: "error", payload: { code: "resume_unavailable", message: "Some earlier events are no longer available" } });
    expect(out[1]).toMatchObject({ kind: "task.completed" });
  });

  it("gives up after bounded retries without progress", async () => {
    const { fn, calls } = mockFetch(() => {
      throw new TypeError("ECONNREFUSED");
    });
    const err = await collect(client(fn).streamEvents("task_1", { retryDelayMs: 1, maxRetries: 3 })).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "stream_interrupted" });
    expect(calls).toHaveLength(4);
  });

  it("does not retry 4xx errors", async () => {
    const { fn, calls } = mockFetch(() => json(404, { error: { code: "not_found", message: "task not found" } }));
    const err = await collect(client(fn).streamEvents("task_x", { retryDelayMs: 1 })).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "not_found", status: 404 });
    expect(calls).toHaveLength(1);
  });

  it("retries 5xx then succeeds", async () => {
    const { fn, calls } = mockFetch((_c, n) => (n < 2 ? new Response("oops", { status: 503 }) : sse([ev(1, "task.completed", { stopReason: "end_turn" })])));
    const out = await collect(client(fn).streamEvents("task_1", { retryDelayMs: 1 }));
    expect(out).toHaveLength(1);
    expect(calls).toHaveLength(3);
  });

  it("stops at once when the task is already terminal and we are past its last event", async () => {
    const { fn, calls } = mockFetch((c) =>
      c.url.endsWith("/events") ? sse([]) : json(200, { taskId: "task_1", state: "completed", stopReason: "end_turn" }),
    );
    const out = await collect(client(fn).streamEvents("task_1", { lastEventId: 10, retryDelayMs: 1 }));
    expect(out).toEqual([]);
    expect(calls.filter((c) => c.url.endsWith("/events"))).toHaveLength(2);
  });

  it("resumes after an idle stall", async () => {
    const { fn, calls } = mockFetch((_c, n) => (n === 0 ? sse([ev(1, "task.accepted", {})], "hang") : sse([ev(2, "task.completed", { stopReason: "end_turn" })])));
    const out = await collect(client(fn).streamEvents("task_1", { idleTimeoutMs: 100, retryDelayMs: 1 }));
    expect(out.map((e) => e.kind)).toEqual(["task.accepted", "task.completed"]);
    expect(calls[1]!.headers["last-event-id"]).toBe("1");
  });

  it("honours an abort signal", async () => {
    const ac = new AbortController();
    const { fn } = mockFetch((c) => {
      return new Promise<Response>((_resolve, reject) => {
        c.init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    setTimeout(() => ac.abort(), 30);
    await expect(collect(client(fn).streamEvents("task_1", { signal: ac.signal }))).rejects.toMatchObject({ code: "aborted" });
  });

  it("closes the underlying connection when the consumer breaks early", async () => {
    let cancelled = false;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(ev(1, "task.accepted", {})));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { fn } = mockFetch(() => new Response(body, { status: 200 }));
    for await (const _e of client(fn).streamEvents("task_1")) break;
    expect(cancelled).toBe(true);
  });
});
