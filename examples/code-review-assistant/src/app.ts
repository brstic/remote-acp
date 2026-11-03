/**
 * EXAMPLE — "Code Review Assistant": a website that runs structured code
 * reviews on the user's own desktop agent through Remote ACP Bridge.
 *
 * What this example shows on top of the minimal one:
 * - server-built structured prompts (the browser only picks a review type),
 * - a server-side collector per review: the server consumes the relay event
 *   stream once, keeps the events in memory and fans them out to any number
 *   of browser tabs (SSE with Last-Event-ID), so past reviews stay viewable,
 * - per-user history (in memory) with strict per-user isolation.
 *
 * DEMO sign-in: pick any username. Everything is in memory.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteAcp, RemoteAcpError, type ConnectionInfo, type StreamItem, type TaskStreamEvent } from "@remote-acp/web-sdk";
import { REVIEW_TYPES, buildPrompt, cleanFocus, reviewType } from "./reviews.js";

/** System instructions this site gives the agent for every review. */
const REVIEWER_INSTRUCTIONS = [
  "You are the Code Review Assistant for this website.",
  "Write the report in Markdown with short sections and bullet points.",
  "Cite findings as file:line. Do not modify, create or delete files.",
].join(" ");

export interface ReviewServerConfig {
  relayUrl: string;
  serviceId: string;
  serviceSecret: string;
  publicDir?: string;
  secureCookies?: boolean;
  pairingTtlSeconds?: number;
  /** Max reviews kept per user (oldest finished ones are dropped). Default 20. */
  historyLimit?: number;
  bridge?: RemoteAcp;
}

type ReviewState = "running" | "completed" | "cancelled" | "failed" | "rejected";

interface Review {
  id: string; // = relay taskId
  typeId: string;
  title: string;
  focus: string;
  prompt: string;
  createdAt: string;
  finishedAt: string | null;
  state: ReviewState;
  stopReason: string | null;
  error: { code: string; message: string } | null;
  /** Relay events in order (seq ascending). Bounded by MAX_STORED_* below. */
  events: TaskStreamEvent[];
  storedTextBytes: number;
  truncated: boolean;
  preview: string;
  done: boolean;
  listeners: Set<(item: StreamItem | null) => void>;
  abort: AbortController;
}

interface UserState {
  pairingId?: string;
  reviews: Map<string, Review>;
}

const USERNAME_RE = /^[a-z][a-z0-9_-]{1,23}$/;
const MAX_BODY = 16 * 1024;
const MAX_STORED_EVENTS = 20_000;
const MAX_STORED_TEXT_BYTES = 512 * 1024;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const externalUserIdFor = (username: string) => `code-review-example:${username}`;

function resolveBrowserHelper(): string {
  return fileURLToPath(import.meta.resolve("@remote-acp/browser-helper"));
}

export function createReviewServer(cfg: ReviewServerConfig): Server {
  const bridge = cfg.bridge ?? new RemoteAcp({ relayUrl: cfg.relayUrl, serviceId: cfg.serviceId, serviceSecret: cfg.serviceSecret });
  const publicDir = cfg.publicDir ?? fileURLToPath(new URL("../public/", import.meta.url));
  const historyLimit = cfg.historyLimit ?? 20;
  const sessions = new Map<string, string>(); // sid -> username
  const users = new Map<string, UserState>();
  const userState = (u: string) => {
    let s = users.get(u);
    if (!s) users.set(u, (s = { reviews: new Map() }));
    return s;
  };
  const cookieAttrs = `Path=/; HttpOnly; SameSite=Lax${cfg.secureCookies ? "; Secure" : ""}`;

  // ------------------------------------------------------------ helpers

  function sessionOf(req: IncomingMessage): { sid: string; username: string } | null {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k !== "review_sid") continue;
      const sid = v.join("=");
      const username = sessions.get(sid);
      if (username) return { sid, username };
    }
    return null;
  }

  function requireUser(req: IncomingMessage): string {
    const s = sessionOf(req);
    if (!s) throw new HttpError(401, "signed_out", "Please sign in first.");
    return s.username;
  }

  function checkOrigin(req: IncomingMessage) {
    const origin = req.headers.origin;
    if (origin === undefined) return;
    let host = "";
    try {
      host = new URL(origin).host;
    } catch {
      /* invalid -> refused below */
    }
    if (host !== req.headers.host) throw new HttpError(403, "bad_origin", "Cross-origin request refused.");
  }

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req as AsyncIterable<Buffer>) {
      if ((size += c.length) > MAX_BODY) throw new HttpError(413, "too_large", "Request body too large.");
      chunks.push(c);
    }
    if (size === 0) return {};
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not an object");
      return v as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "bad_json", "Invalid JSON body.");
    }
  }

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  }

  function sendError(res: ServerResponse, e: unknown) {
    if (e instanceof HttpError) return send(res, e.status, { error: { code: e.code, message: e.message } });
    if (e instanceof RemoteAcpError) {
      if (e.code === "unauthorized") {
        return send(res, 502, { error: { code: "relay_auth_failed", message: "This server's relay credentials are invalid." } });
      }
      return send(res, e.status >= 400 && e.status < 600 ? e.status : 502, { error: { code: e.code, message: e.message } });
    }
    console.error("[code-review] unexpected error", e);
    return send(res, 500, { error: { code: "internal", message: "Something went wrong." } });
  }

  async function currentConnection(username: string): Promise<{ current: ConnectionInfo | null; latest: ConnectionInfo | null }> {
    const list = await bridge.listConnections(externalUserIdFor(username));
    return { current: list.find((c) => c.status === "active" || c.status === "paused") ?? null, latest: list[0] ?? null };
  }

  const publicConnection = (c: ConnectionInfo | null) =>
    c && { connectionId: c.connectionId, status: c.status, online: c.online, provider: c.provider, createdAt: c.createdAt, expiresAt: c.expiresAt };

  const summary = (r: Review) => ({
    id: r.id,
    type: r.typeId,
    title: r.title,
    focus: r.focus,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
    state: r.state,
    stopReason: r.stopReason,
    error: r.error,
    preview: r.preview,
  });

  function ownReview(username: string, id: string): Review {
    const r = userState(username).reviews.get(id);
    if (!r) throw new HttpError(404, "not_found", "Review not found.");
    return r;
  }

  // ------------------------------------------------------------ collector

  /** Consume the relay stream for one review and keep its events in memory. */
  async function collect(r: Review) {
    const emit = (item: StreamItem | null) => {
      for (const l of r.listeners) l(item);
    };
    try {
      for await (const item of bridge.streamEvents(r.id, { signal: r.abort.signal })) {
        if (!("seq" in item)) {
          emit(item); // relay notice (e.g. resume_unavailable): pass through, not stored
          continue;
        }
        const ev = item;
        if (ev.kind === "task.event" && (ev.payload.type === "text_delta" || ev.payload.type === "thought_delta")) {
          const bytes = Buffer.byteLength(ev.payload.text);
          if (r.storedTextBytes + bytes > MAX_STORED_TEXT_BYTES || r.events.length >= MAX_STORED_EVENTS) {
            r.truncated = true;
            continue; // keep memory bounded; the terminal event is still stored
          }
          r.storedTextBytes += bytes;
          if (ev.payload.type === "text_delta" && r.preview.length < 200) r.preview = (r.preview + ev.payload.text).slice(0, 200);
        }
        r.events.push(ev);
        if (ev.kind === "task.completed") {
          r.stopReason = ev.payload.stopReason;
          r.state = ev.payload.stopReason === "cancelled" ? "cancelled" : "completed";
        } else if (ev.kind === "task.failed" || ev.kind === "task.rejected") {
          r.state = ev.kind === "task.failed" ? "failed" : "rejected";
          r.error = { code: ev.payload.code, message: ev.payload.message };
        }
        emit(ev);
      }
    } catch (e) {
      if (!r.abort.signal.aborted) {
        r.state = "failed";
        r.error = e instanceof RemoteAcpError ? { code: e.code, message: e.message } : { code: "internal", message: "Event stream failed" };
      }
    } finally {
      if (r.state === "running") {
        r.state = "failed";
        r.error ??= { code: "stream_interrupted", message: "Lost the event stream for this review" };
      }
      r.finishedAt = new Date().toISOString();
      r.done = true;
      emit(null);
      r.listeners.clear();
    }
  }

  function trimHistory(u: UserState) {
    if (u.reviews.size <= historyLimit) return;
    for (const [id, r] of u.reviews) {
      if (u.reviews.size <= historyLimit) break;
      if (r.done) u.reviews.delete(id);
    }
  }

  // ------------------------------------------------------------ routes

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? "GET";
    if (method !== "GET") checkOrigin(req);

    if (path === "/api/me" && method === "GET") {
      const s = sessionOf(req);
      return send(res, 200, { user: s ? { username: s.username } : null });
    }
    if (path === "/api/login" && method === "POST") {
      const body = await readJson(req);
      const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
      if (!USERNAME_RE.test(username)) {
        throw new HttpError(400, "invalid_username", "Use 2-24 lowercase letters, digits, '-' or '_', starting with a letter.");
      }
      const old = sessionOf(req);
      if (old) sessions.delete(old.sid);
      const sid = randomBytes(32).toString("base64url");
      sessions.set(sid, username);
      return send(res, 200, { user: { username } }, { "set-cookie": `review_sid=${sid}; ${cookieAttrs}; Max-Age=86400` });
    }
    if (path === "/api/logout" && method === "POST") {
      const s = sessionOf(req);
      if (s) sessions.delete(s.sid);
      return send(res, 200, { ok: true }, { "set-cookie": `review_sid=; ${cookieAttrs}; Max-Age=0` });
    }
    if (path === "/api/review-types" && method === "GET") {
      return send(res, 200, { types: REVIEW_TYPES.map(({ id, title, description }) => ({ id, title, description })) });
    }

    const username = requireUser(req);
    const user = userState(username);

    if (path === "/api/connection" && method === "GET") {
      const { current, latest } = await currentConnection(username);
      return send(res, 200, { connection: publicConnection(current), latest: publicConnection(latest) });
    }
    if (path === "/api/connection/disconnect" && method === "POST") {
      const { current } = await currentConnection(username);
      if (current) await bridge.revokeConnection(current.connectionId);
      return send(res, 200, { ok: true, revoked: current ? 1 : 0 });
    }
    if (path === "/api/pairings" && method === "POST") {
      const p = await bridge.createPairing({
        externalUserId: externalUserIdFor(username),
        scopes: ["task.interactive"],
        expiresInSeconds: cfg.pairingTtlSeconds ?? 120,
      });
      user.pairingId = p.pairingId;
      return send(res, 200, { url: p.url, code: p.code, expiresAt: p.expiresAt });
    }
    if (path === "/api/pairings/current" && method === "GET") {
      if (!user.pairingId) return send(res, 200, { pairing: null, connection: null });
      const p = await bridge.getPairing(user.pairingId);
      const conn = p.status === "accepted" && p.connectionId ? await bridge.getConnection(p.connectionId) : null;
      return send(res, 200, { pairing: { status: p.status, expiresAt: p.expiresAt }, connection: publicConnection(conn) });
    }

    if (path === "/api/reviews" && method === "GET") {
      return send(res, 200, { reviews: [...user.reviews.values()].reverse().map(summary) });
    }
    if (path === "/api/reviews" && method === "POST") {
      const body = await readJson(req);
      const type = reviewType(body.type);
      if (!type) throw new HttpError(400, "invalid_type", "Pick a review type.");
      const focus = cleanFocus(body.focus);
      const prompt = buildPrompt(type, focus);
      const { current } = await currentConnection(username);
      if (!current) throw new HttpError(409, "not_connected", "Connect your desktop agent first.");
      const idem = typeof body.idempotencyKey === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.idempotencyKey) ? body.idempotencyKey : randomUUID();
      const task = await bridge.startTask({
        connectionId: current.connectionId,
        externalUserId: externalUserIdFor(username),
        prompt,
        idempotencyKey: `${username}:${idem}`.slice(0, 128),
        // Website-provided system instructions: appended to the agent's own
        // system prompt for this session (shown to the user on the desktop).
        instructions: REVIEWER_INSTRUCTIONS,
      });
      const existing = user.reviews.get(task.taskId); // idempotent retry
      if (existing) return send(res, 200, summary(existing));
      const review: Review = {
        id: task.taskId,
        typeId: type.id,
        title: type.title,
        focus,
        prompt,
        createdAt: task.createdAt,
        finishedAt: null,
        state: "running",
        stopReason: null,
        error: null,
        events: [],
        storedTextBytes: 0,
        truncated: false,
        preview: "",
        done: false,
        listeners: new Set(),
        abort: new AbortController(),
      };
      user.reviews.set(review.id, review);
      trimHistory(user);
      void collect(review);
      return send(res, 201, summary(review));
    }

    const m = /^\/api\/reviews\/([A-Za-z0-9_.:-]{1,128})(\/cancel|\/events)?$/.exec(path);
    if (m) {
      const review = ownReview(username, m[1]!);
      if (!m[2] && method === "GET") return send(res, 200, { ...summary(review), prompt: review.prompt, truncated: review.truncated });
      if (m[2] === "/cancel" && method === "POST") return send(res, 200, await bridge.cancelTask(review.id));
      if (m[2] === "/events" && method === "GET") return streamReview(req, res, review);
    }
    throw new HttpError(404, "not_found", "No such endpoint.");
  }

  /** Replay stored events after Last-Event-ID, then follow live ones. */
  function streamReview(req: IncomingMessage, res: ServerResponse, r: Review) {
    const raw = req.headers["last-event-id"];
    const last = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : 0;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");
    const write = (item: StreamItem | null) => {
      if (item === null) {
        res.write(`event: end\ndata: ${JSON.stringify({ state: r.state, error: r.error })}\n\n`);
        cleanup();
        res.end();
      } else if ("seq" in item) {
        if (item.seq > last) res.write(`id: ${item.seq}\nevent: ${item.kind}\ndata: ${JSON.stringify(item)}\n\n`);
      } else {
        res.write(`event: notice\ndata: ${JSON.stringify(item.payload)}\n\n`);
      }
    };
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    const cleanup = () => {
      clearInterval(keepAlive);
      r.listeners.delete(write);
    };
    res.on("close", cleanup);
    for (const ev of r.events) write(ev);
    if (r.truncated) res.write(`event: notice\ndata: ${JSON.stringify({ code: "truncated", message: "Part of this report was too long to keep." })}\n\n`);
    if (r.done) write(null);
    else r.listeners.add(write);
  }

  async function serveStatic(res: ServerResponse, path: string) {
    let file: string;
    if (path === "/vendor/browser-helper.js") file = resolveBrowserHelper();
    else {
      const rel = path === "/" ? "index.html" : decodeURIComponent(path).replace(/^\/+/, "");
      file = normalize(join(publicDir, rel));
      if (!file.startsWith(normalize(publicDir + sep))) throw new HttpError(404, "not_found", "Not found");
    }
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      throw new HttpError(404, "not_found", "Not found");
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  }

  const server = createServer((req, res) => {
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const handler = path.startsWith("/api/")
      ? api(req, res, path)
      : req.method === "GET"
        ? serveStatic(res, path)
        : Promise.reject(new HttpError(405, "method", "Method not allowed"));
    handler.catch((e: unknown) => {
      if (res.headersSent) return res.end();
      sendError(res, e);
    });
  });
  server.on("close", () => {
    for (const u of users.values()) for (const r of u.reviews.values()) r.abort.abort();
  });
  return server;
}
