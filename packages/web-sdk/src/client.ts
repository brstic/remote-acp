import type {
  CancelTaskResponse,
  ConnectionInfo,
  CreatePairingRequest,
  CreatePairingResponse,
  ListConnectionsResponse,
  PairingStatusResponse,
  StreamErrorEvent,
  TaskStreamEvent,
  TaskSummary,
} from "@remote-acp/protocol-types";
import { RemoteAcpError, errorFromResponse } from "./errors.js";
import { parseSseStream } from "./sse.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RemoteAcpOptions {
  /** Registered service id, e.g. `svc_demo`. */
  serviceId: string;
  /** Service secret (never ship to a browser). */
  serviceSecret: string;
  /** Relay base URL. Must be https unless the host is localhost / 127.0.0.1 / [::1]. */
  relayUrl: string;
  /** Custom fetch implementation (defaults to `globalThis.fetch`). */
  fetch?: FetchLike;
  /** Per-request timeout for REST calls in ms (default 15000). Not applied to event streams. */
  requestTimeoutMs?: number;
}

export interface StartTaskInput {
  connectionId: string;
  externalUserId: string;
  prompt: string;
  /**
   * Required for safe retries: re-sending the same key returns the original
   * task instead of starting a second one. Generated if omitted.
   */
  idempotencyKey?: string;
}

export interface WaitForPairingOptions {
  signal?: AbortSignal;
  /** Give up after this many ms (default: until the pairing's own expiry + 5s). */
  timeoutMs?: number;
  /** Poll interval in ms (default 1000). */
  intervalMs?: number;
}

export interface StreamEventsOptions {
  /** Resume after this relay sequence number (sent as `Last-Event-ID`). */
  lastEventId?: number | string;
  signal?: AbortSignal;
  /** Max consecutive reconnect attempts without progress (default 5). */
  maxRetries?: number;
  /** Base backoff between reconnects in ms (default 250, doubled per attempt, capped at 5000, with jitter). */
  retryDelayMs?: number;
  /**
   * Abort and resume the stream if nothing (not even a keep-alive) arrives
   * for this long. The relay sends keep-alives every 15s. Default 45000; 0 disables.
   */
  idleTimeoutMs?: number;
}

/** Items yielded by {@link RemoteAcp.streamEvents}. */
export type StreamItem = TaskStreamEvent | StreamErrorEvent;

const TERMINAL_KINDS = new Set(["task.completed", "task.failed", "task.rejected"]);
const TERMINAL_STATES = new Set(["completed", "cancelled", "failed", "rejected"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortedError(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortedError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortedError(signal?: AbortSignal, cause?: unknown): RemoteAcpError {
  return new RemoteAcpError("aborted", "The operation was aborted", 0, { cause: cause ?? signal?.reason });
}

function randomKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  throw new RemoteAcpError("invalid_config", "crypto.randomUUID is unavailable; pass idempotencyKey explicitly");
}

/**
 * Server-side client for a Remote ACP Bridge relay.
 *
 * Every method authenticates as the registered service. Your backend must
 * authenticate its own signed-in user first and only pass that user's id as
 * `externalUserId`.
 */
export class RemoteAcp {
  readonly serviceId: string;
  readonly relayUrl: string;
  readonly #authorization: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(opts: RemoteAcpOptions) {
    if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
      throw new RemoteAcpError(
        "invalid_config",
        "@remote-acp/web-sdk is server-side only. Never ship the service secret to a browser; use @remote-acp/browser-helper in the browser and call your own backend.",
      );
    }
    if (!opts || typeof opts.serviceId !== "string" || !/^svc_[A-Za-z0-9_.:-]{1,124}$/.test(opts.serviceId)) {
      throw new RemoteAcpError("invalid_config", "serviceId must look like svc_...");
    }
    if (typeof opts.serviceSecret !== "string" || opts.serviceSecret.length < 16) {
      throw new RemoteAcpError("invalid_config", "serviceSecret is missing or too short");
    }
    let url: URL;
    try {
      url = new URL(opts.relayUrl);
    } catch {
      throw new RemoteAcpError("invalid_config", "relayUrl is not a valid URL");
    }
    const local = LOCAL_HOSTS.has(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      throw new RemoteAcpError("invalid_config", "relayUrl must use https:// (http:// is only allowed for localhost)");
    }
    const f = opts.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new RemoteAcpError("invalid_config", "No fetch implementation available (Node >= 20 required)");
    this.serviceId = opts.serviceId;
    this.relayUrl = url.origin + url.pathname.replace(/\/+$/, "");
    this.#authorization = `Bearer ${opts.serviceId}.${opts.serviceSecret}`;
    this.#fetch = f;
    this.#timeoutMs = opts.requestTimeoutMs ?? 15_000;
  }

  /** Avoid leaking the secret through `console.log(client)` / JSON. */
  toJSON(): Record<string, string> {
    return { serviceId: this.serviceId, relayUrl: this.relayUrl };
  }

  // ------------------------------------------------------------------ REST

  async #request<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.#fetch(this.relayUrl + path, {
        method,
        headers: {
          authorization: this.#authorization,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: combined,
      });
    } catch (e) {
      if (signal?.aborted) throw abortedError(signal, e);
      if (timeout.aborted) throw new RemoteAcpError("timeout", `Relay request timed out after ${this.#timeoutMs}ms`, 0, { cause: e });
      throw new RemoteAcpError("network_error", `Could not reach the relay: ${(e as Error)?.message ?? e}`, 0, { cause: e });
    }
    if (!res.ok) throw await errorFromResponse(res);
    try {
      return (await res.json()) as T;
    } catch (e) {
      throw new RemoteAcpError("invalid_response", "Relay returned invalid JSON", res.status, { cause: e });
    }
  }

  /** Create a one-time, short-lived pairing challenge for one of your users. */
  createPairing(input: CreatePairingRequest, opts?: { signal?: AbortSignal }): Promise<CreatePairingResponse> {
    return this.#request("POST", "/v1/pairings", input, opts?.signal);
  }

  getPairing(pairingId: string, opts?: { signal?: AbortSignal }): Promise<PairingStatusResponse> {
    return this.#request("GET", `/v1/pairings/${encodeURIComponent(pairingId)}`, undefined, opts?.signal);
  }

  /**
   * Poll a pairing until it is `accepted`, `rejected` or `expired`.
   * Resolves with the final status (it does not throw for rejected/expired).
   */
  async waitForPairing(pairingId: string, opts: WaitForPairingOptions = {}): Promise<PairingStatusResponse> {
    const interval = Math.max(50, opts.intervalMs ?? 1000);
    const started = Date.now();
    let deadline = opts.timeoutMs !== undefined ? started + opts.timeoutMs : undefined;
    for (;;) {
      const p = await this.getPairing(pairingId, opts.signal ? { signal: opts.signal } : undefined);
      if (p.status === "accepted" || p.status === "rejected" || p.status === "expired") return p;
      if (deadline === undefined) {
        const exp = Date.parse(p.expiresAt);
        deadline = Number.isNaN(exp) ? started + 10 * 60_000 : exp + 5_000;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new RemoteAcpError("timeout", "Timed out waiting for the pairing to be approved");
      await sleep(Math.min(interval, remaining), opts.signal);
    }
  }

  /** Connections the given end user granted to this service (newest first). */
  async listConnections(externalUserId: string, opts?: { signal?: AbortSignal }): Promise<ConnectionInfo[]> {
    const r = await this.#request<ListConnectionsResponse>(
      "GET",
      `/v1/connections?externalUserId=${encodeURIComponent(externalUserId)}`,
      undefined,
      opts?.signal,
    );
    return r.connections;
  }

  getConnection(connectionId: string, opts?: { signal?: AbortSignal }): Promise<ConnectionInfo> {
    return this.#request("GET", `/v1/connections/${encodeURIComponent(connectionId)}`, undefined, opts?.signal);
  }

  async revokeConnection(connectionId: string, opts?: { signal?: AbortSignal }): Promise<void> {
    await this.#request("POST", `/v1/connections/${encodeURIComponent(connectionId)}/revoke`, {}, opts?.signal);
  }

  /**
   * Start a user-visible interactive task. The relay dispatches it at most
   * once; retrying with the same `idempotencyKey` returns the same task.
   */
  startTask(input: StartTaskInput, opts?: { signal?: AbortSignal }): Promise<TaskSummary> {
    return this.#request(
      "POST",
      "/v1/tasks",
      {
        connectionId: input.connectionId,
        externalUserId: input.externalUserId,
        prompt: input.prompt,
        idempotencyKey: input.idempotencyKey ?? randomKey(),
      },
      opts?.signal,
    );
  }

  getTask(taskId: string, opts?: { signal?: AbortSignal }): Promise<TaskSummary> {
    return this.#request("GET", `/v1/tasks/${encodeURIComponent(taskId)}`, undefined, opts?.signal);
  }

  cancelTask(taskId: string, opts?: { signal?: AbortSignal }): Promise<CancelTaskResponse> {
    return this.#request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {}, opts?.signal);
  }

  // ------------------------------------------------------------------ SSE

  /**
   * Stream a task's events. Yields `{seq, kind, payload}` objects and ends
   * after the terminal event (`task.completed` / `task.failed` / `task.rejected`).
   *
   * On a network drop, idle stall, 5xx or relay `lagged` notice the stream is
   * transparently resumed with `Last-Event-ID` (events are de-duplicated by
   * `seq`). After `maxRetries` consecutive failures without progress it throws
   * `RemoteAcpError("stream_interrupted")`. A relay `resume_unavailable`
   * notice (older events were dropped from the bounded buffer) is yielded as
   * `{kind: "error", payload}` and streaming continues.
   */
  async *streamEvents(taskId: string, opts: StreamEventsOptions = {}): AsyncGenerator<StreamItem, void, undefined> {
    const maxRetries = opts.maxRetries ?? 5;
    const baseDelay = opts.retryDelayMs ?? 250;
    const idleMs = opts.idleTimeoutMs ?? 45_000;
    const url = `${this.relayUrl}/v1/tasks/${encodeURIComponent(taskId)}/events`;
    let last: number | undefined =
      opts.lastEventId === undefined || opts.lastEventId === "" ? undefined : Number(opts.lastEventId);
    if (last !== undefined && (!Number.isInteger(last) || last < 0)) {
      throw new RemoteAcpError("invalid_config", "lastEventId must be a non-negative integer");
    }
    let failures = 0;
    let lastError: unknown;
    let terminalCheckDone = false;

    for (;;) {
      if (opts.signal?.aborted) throw abortedError(opts.signal);
      const attempt = new AbortController();
      const signal = opts.signal ? AbortSignal.any([opts.signal, attempt.signal]) : attempt.signal;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let idleFired = false;
      const armIdle = () => {
        if (!idleMs) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleFired = true;
          attempt.abort(new Error("idle timeout"));
        }, idleMs);
      };
      let progressed = false;
      let ended: "terminal" | "eof" | "error" = "eof";
      try {
        armIdle();
        let res: Response;
        try {
          res = await this.#fetch(url, {
            method: "GET",
            headers: {
              authorization: this.#authorization,
              accept: "text/event-stream",
              "cache-control": "no-cache",
              ...(last !== undefined ? { "last-event-id": String(last) } : {}),
            },
            signal,
          });
        } catch (e) {
          if (opts.signal?.aborted) throw abortedError(opts.signal, e);
          throw new RemoteAcpError("network_error", `Could not reach the relay: ${(e as Error)?.message ?? e}`, 0, { cause: e });
        }
        if (!res.ok) {
          const err = await errorFromResponse(res);
          if (res.status >= 500 || res.status === 429) throw err; // retryable below
          throw Object.assign(err, { fatal: true });
        }
        if (!res.body) throw new RemoteAcpError("invalid_response", "Relay returned an empty event stream", res.status);

        const tapped = tapBytes(res.body, armIdle, signal);
        for await (const msg of parseSseStream(tapped)) {
          if (msg.event === "error") {
            const p = safeJson(msg.data) as { code?: unknown; message?: unknown } | undefined;
            const code = typeof p?.code === "string" ? p.code : "stream_error";
            const message = typeof p?.message === "string" ? p.message : msg.data;
            if (code === "lagged") {
              // Relay dropped us because we were too slow; resume from `last`.
              lastError = new RemoteAcpError("lagged", message);
              ended = "error";
              break;
            }
            yield { kind: "error", payload: { code, message } };
            continue;
          }
          const data = safeJson(msg.data) as TaskStreamEvent | undefined;
          if (!data || typeof data.seq !== "number" || typeof data.kind !== "string") {
            throw Object.assign(new RemoteAcpError("invalid_response", "Malformed event from relay"), { fatal: true });
          }
          if (last !== undefined && data.seq <= last) continue; // de-duplicate after resume
          last = data.seq;
          progressed = true;
          failures = 0;
          yield data;
          if (TERMINAL_KINDS.has(data.kind)) {
            ended = "terminal";
            return;
          }
        }
      } catch (e) {
        if (opts.signal?.aborted) throw abortedError(opts.signal, e);
        if ((e as { fatal?: boolean })?.fatal) throw e;
        if (e instanceof RemoteAcpError && !e.retryable && e.code !== "network_error") throw e;
        lastError = idleFired ? new RemoteAcpError("timeout", `No data from relay for ${idleMs}ms`, 0, { cause: e }) : e;
        ended = "error";
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        if (ended !== "terminal") attempt.abort();
      }

      // The stream ended without a terminal event.
      if (ended === "eof" && !progressed) {
        // The relay closes immediately if the task is already terminal and we
        // are past its last event. Check once instead of spinning.
        try {
          const t = await this.getTask(taskId, opts.signal ? { signal: opts.signal } : undefined);
          if (TERMINAL_STATES.has(t.state)) {
            if (terminalCheckDone) return;
            terminalCheckDone = true;
            continue; // one more pass to drain any remaining backlog
          }
        } catch (e) {
          if (e instanceof RemoteAcpError && (e.status === 404 || e.status === 401 || e.code === "aborted")) throw e;
          lastError = e;
        }
      }
      if (!progressed) failures++;
      if (failures > maxRetries) {
        throw new RemoteAcpError(
          "stream_interrupted",
          `Event stream for ${taskId} was interrupted and could not be resumed after ${maxRetries} retries`,
          0,
          { cause: lastError },
        );
      }
      if (failures > 0) {
        const delay = Math.min(5000, baseDelay * 2 ** (failures - 1));
        await sleep(delay / 2 + Math.random() * (delay / 2), opts.signal);
      }
    }
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Pass bytes through while calling `onBytes` for each chunk (idle detection).
 * Also stops reading as soon as `signal` aborts, even if the underlying body
 * does not observe the signal itself.
 */
async function* tapBytes(body: ReadableStream<Uint8Array>, onBytes: () => void, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let finished = false;
  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  aborted.catch(() => undefined);
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) {
        finished = true;
        return;
      }
      onBytes();
      if (value) yield value;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}
